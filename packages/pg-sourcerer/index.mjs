#!/usr/bin/env bun
// @ts-check
import path from "path";
import _debug from "debug";
import fs from "fs/promises";
import { transform } from "inflection";
import {
  entityPermissions,
  makeIntrospectionQuery,
  parseIntrospectionResults,
} from "pg-introspection";
import recast from "recast";
import { lilconfig } from "lilconfig";
import { z } from "zod";
import partition from "lodash.partition";
import pg from "pg";
import invariant from "tiny-invariant";

main();

const debug = _debug("pg-sourcerer");

const inflectionsSchema = z
  .record(
    z.array(
      z.union([
        z.literal("pluralize"),
        z.literal("singularize"),
        z.literal("camelize"),
        z.literal("underscore"),
        z.literal("humanize"),
        z.literal("capitalize"),
        z.literal("dasherize"),
        z.literal("titleize"),
        z.literal("demodulize"),
        z.literal("tableize"),
        z.literal("classify"),
        z.literal("foreignKey"),
        z.literal("ordinalize"),
      ]),
    ),
  )
  .optional();

export const userConfig = z.object({
  connectionString: z.string(),
  adapter: z.union([z.literal("pg"), z.literal("postgres")]),
  outputDir: z.string(),
  outputExtension: z.string(),
  typeMap: z
    .record(
      z.union([
        z.literal("string"),
        z.literal("boolean"),
        z.literal("number"),
        z.literal("Date"),
        z.literal("unknown"),
      ]),
    )
    .optional(),
  role: z.string().optional(),
  inflections: inflectionsSchema,
  plugins: z.array(
    z.object({
      name: z.string(),
      inflections: inflectionsSchema,
      // TODO: other possible phases?
      render: z
        .function()
        .args(z.any())
        .returns(
          z.array(
            z
              .object({
                content: z.any(), // ast builder can take care of itself
                path: z.string(),
                exports: z
                  .array(
                    z.object({
                      identifier: z.string(),
                      kind: z.union([
                        z.literal("type"),
                        z.literal("zodSchema"),
                        z.record(
                          // z.union([
                          z.function(z.tuple([]), z.any()),
                          // ]),
                        ),
                      ]),
                    }),
                  )
                  .refine(
                    entries => {
                      const [values, types] = partition(entries, e => e.kind === "type");
                      const typeIdentifiers = new Set(types.map(e => e.identifier));
                      const valueIdentifiers = new Set(values.map(e => e.identifier));
                      return (
                        typeIdentifiers.size === types.length &&
                        valueIdentifiers.size === values.length
                      );
                    },
                    { message: "export identifiers must be unique" },
                  ),
                imports: z
                  .array(
                    z
                      .object({
                        typeImport: z.boolean().optional(),
                        identifier: z.string(),
                        default: z.boolean().optional(),
                        path: z.string(),
                      })
                      .strict(),
                  )
                  .optional(),
              })
              .optional(),
          ),
        ),
    }),
  ),
});

/** @typedef {z.infer<typeof userConfig>} Config */
/** @typedef {z.infer<typeof inflectionsSchema>} Inflections */

/** @returns {Promise<Config>} */
export async function parseConfig() {
  let configSearch = await lilconfig("pgsourcerer").search();
  if (!configSearch) {
    // TODO: what if we codegen a config from prompts?
    console.error("a pgsourcerer config is required");
    process.exit(1);
  }
  let config;
  try {
    config = userConfig.parse(configSearch.config);
  } catch (e) {
    console.log(e instanceof z.ZodError ? e.flatten() : e);
    process.exit(1);
  }

  return config;
}

/** @typedef {{ typeImport?: boolean, identifier: string, default?: boolean, path: string}} ImportSpec */

/** @typedef {ReturnType<Config['plugins'][number]['render']>[number]} Output */

const utils = {
  getTypeName,
  getTSTypeNameFromPgType,
  getASTTypeFromTypeName,
  getOperatorsFrom,
  getPermissions,
  getDescription,
  findExports,
  builders: recast.types.builders,
};

/** @typedef {{
  name: string,
  inflections?: Inflections;
  render(info: {
    introspection: { schemas: Record<string, DbSchema> };
    output: Array<Output> | null;
    config: Config;
    utils: typeof utils;
  }): Array<Output>
}} Plugin */

/** @returns {Promise<void>} */
async function main() {
  const config = await parseConfig();

  if (!("plugins" in config)) {
    console.error("no plugins defined, nothing to do");
    return process.exit(0);
  }

  const introspectionQuery = makeIntrospectionQuery();
  const introspectionResult = await (async () => {
    const pool = new pg.Pool({ connectionString: config.connectionString });
    const client = await pool.connect();
    await client.query("begin");
    if (config.role) {
      await client.query("select set_config('role', $1, false)", [config.role]);
    }
    const { rows } = await client.query(introspectionQuery);
    await client.query("rollback");
    client.release();
    pool.end();
    return rows[0].introspection;
  })();

  const introspection = processIntrospection(parseIntrospectionResults(introspectionResult, true));

  const output = pluginRunner(config, introspection);

  if (!output) {
    console.error("no output from plugins");
    return process.exit(1);
  }

  await writePluginOutput(output, config);
}

/**
 * @param {Config} config
 * @param {Introspection} introspection
 */
export function pluginRunner(config, introspection) {
  // @workspace compose plugin.inflections
  const inflections = config.plugins.reduce(
    (o, plugin) => {
      if (plugin.inflections) {
        for (const key in plugin.inflections) {
          const inflections = (config.inflections?.[key] ?? []).concat(
            plugin.inflections[key] ?? [],
          );
          o[key] = str => transform(str, inflections);
        }
      }
      return o;
    },
    { columns: s => s },
  );
  config.inflections = inflections;
  return config.plugins.reduce((prevOutput, plugin) => {
    const newOutput = plugin.render({
      introspection,
      output: prevOutput,
      config,
      utils,
    });
    return prevOutput ? prevOutput.concat(newOutput) : newOutput;
  }, /** @type {null | Array<Output>} */ (null));
}

/**
 * Writes plugin output to disk
 * @param {Array<Output>} output - Plugin output to write
 * @param {Config} config - Configuration object for output settings
 * @returns {Promise<void>}
 */
export async function writePluginOutput(output, config) {
  if (!output.length) {
    console.error("no output from plugins");
    return process.exit(1);
  }

  Object.entries(Object.groupBy(output, o => o.path)).forEach(async ([strPath, files]) => {
    const parsedFile = path.parse(path.join(config.outputDir ?? "./", strPath));
    const filepath = parsedFile.dir;
    const newPath = path.join(parsedFile.dir, parsedFile.base);
    const result = recast.print(
      recast.types.builders.program([
        ...parseDependencies(files.flatMap(f => f.imports ?? [])),
        ...files.flatMap(f => f.content),
      ]),
      { tabWidth: 2 },
    );

    await fs.mkdir(filepath, { recursive: true });
    await fs.writeFile(newPath, result.code, "utf8");
    console.log('wrote file "%s"', newPath.replace(import.meta.dirname, "."));
  });
}

/** @param {import("pg-introspection").PgType} type */
function getTypeName(type) {
  return [type.getNamespace()?.nspname, type.typname].join(".");
}

/**
 * might implement a custom metadata parser later
 * @param {{ getDescription(): string | undefined }} entity
 */
function getDescription(entity) {
  return entity.getDescription();
}

/** @typedef {{ name: string, schemas: Record<string, DbSchema> }} Introspection */

/**
 * @param {import("pg-introspection").Introspection} introspection
 * @returns {Introspection}
 */
function processIntrospection(introspection) {
  const role = introspection.getCurrentUser();
  invariant(role, "who am i???");
  return {
    name: introspection.database.datname,
    schemas: Object.fromEntries(
      introspection.namespaces.map(schema => [
        schema.nspname,
        processSchema(schema, { introspection, role }),
      ]),
    ),
  };
}

/**
 * @param {Parameters<typeof entityPermissions>[1]} entity
 * @param {{
     introspection: import("pg-introspection").Introspection,
     role: import("pg-introspection").PgRoles,
   }}
 * @returns {{canSelect?: boolean, canInsert?: boolean, canUpdate?: boolean, canDelete?: boolean, canExecute?: boolean}}
 */
function getPermissions(entity, { introspection, role }) {
  // licensed under MIT from Benjie Gillam
  // https://github.com/graphile/crystal/blob/9d1c54a28e29a2da710ba093541b4a03bab6b5c6/graphile-build/graphile-build-pg/src/plugins/PgRBACPlugin.ts
  switch (entity._type) {
    case "PgAttribute": {
      const table = entity.getClass();
      invariant(table, `couldn't find table for attribute ${entity.attname}`);
      const attributePermissions = entityPermissions(introspection, entity, role, true);
      const tablePermissions = entityPermissions(introspection, table, role, true);
      const canSelect = attributePermissions.select || Boolean(tablePermissions.select);
      const canInsert = attributePermissions.insert || Boolean(tablePermissions.insert);
      const canUpdate = attributePermissions.update || Boolean(tablePermissions.update);
      return { canSelect, canInsert, canUpdate };
    }
    case "PgClass": {
      const perms = entityPermissions(introspection, entity, role, true);
      let canSelect = perms.select ?? false;
      let canInsert = perms.insert ?? false;
      let canUpdate = perms.update ?? false;
      const canDelete = perms.delete ?? false;
      if (!canInsert || !canUpdate || !canSelect) {
        const attributePermissions = entity
          .getAttributes()
          .filter(att => att.attnum > 0)
          .map(att => entityPermissions(introspection, att, role, true));
        for (const attributePermission of attributePermissions) {
          canSelect ||= Boolean(attributePermission.select);
          canInsert ||= Boolean(attributePermission.insert);
          canUpdate ||= Boolean(attributePermission.update);
        }
      }
      return { canSelect, canInsert, canUpdate, canDelete };
    }
    case "PgProc": {
      const { execute } = entityPermissions(introspection, entity, role, true);
      return { canExecute: execute };
    }
    default:
      invariant(false, `unknown entity type "${entity._type}"`);
  }
}
/** @typedef {ReturnType<typeof getPermissions>} Permissions */

/** @typedef {{
  name: string;
  views: Record<string, DbView>;
  tables: Record<string, DbTable>;
  functions: Record<string, DbFunction>;
  types: Record<string, DbType>;
}} DbSchema */

/**
 * @param {import("pg-introspection").PgNamespace} schema
 * @param {{
     introspection: import("pg-introspection").Introspection;
     role: import("pg-introspection").PgRoles,
   }}
 * @returns {DbSchema}
 */
function processSchema(schema, { introspection, role }) {
  return {
    name: schema.nspname,
    views: processViews(schema.oid, { introspection, role }),
    tables: processTables(schema.oid, { introspection, role }),
    functions: processFunctions(schema.oid, { introspection, role }),
    types: processTypes(schema.oid, { introspection, role }),
    // permissions: getPermissions(schema, { introspection, role }),
  };
}

/**@typedef {
 *   | { kind: "domain",    name: string, type: "text" }
 *   | { kind: "enum",      name: string, values: Array<string> }
 *   | { composite: "enum", name: string, type: Array<{ name: string, type: string }> }
 * } DbType
 */

/**
 * @param {string} schemaId
 * @param {{
     introspection: import("pg-introspection").Introspection,
   }} _
 * @returns {Record<string, DbType>} 
 */
function processTypes(schemaId, { introspection }) {
  const domains = introspection.types
    .filter(t => t.typtype === "d" && t.typnamespace === schemaId)
    .map(t => /** @type {const} */ ({ name: t.typname, kind: "domain", type: t.typoutput }));

  const enums = introspection.types
    .filter(t => t.typtype === "e" && t.typnamespace === schemaId)
    .map(t => {
      const values = t.getEnumValues();
      invariant(values, `could not find enum values for ${t.typname}`);
      return /** @type {const} */ ({
        name: t.typname,
        kind: "enum",
        values: values.map(x => x.enumlabel),
      });
    });

  const composites = introspection.classes
    .filter(cls => cls.relnamespace === schemaId && cls.relkind === "c")
    .map(t => ({
      name: t.relname,
      kind: "composite",
      values: t.getAttributes().map(a => {
        const type = a.getType();
        invariant(type, `could not find type for composite attribute ${t.relname}`);
        return /** @type {const} */ ({ name: a.attname, type: getTypeName(type) });
      }),
    }));

  const ts = [...domains, ...enums, ...composites];
  const types = ts.reduce((prev, curr) => {
    if (!prev[curr.name]) {
      prev[curr.name] = [];
    }
    prev[curr.name].push(curr);
    return prev;
  }, /** @type {Record<string, typeof ts>} */ ({}));
  return types;
}

/** @typedef {{
  name: string;
  columns: Record<string, DbColumn>;
  constraints: Record<string, DbReference>;
  description: string | undefined;
  permissions: Permissions;
}} DbView */

/**
 * @param {string} schemaId
 * @param {{
     introspection: import("pg-introspection").Introspection,
     role: import("pg-introspection").PgRoles,
   }}
 * @returns {Record<string, DbView>}
 */
function processViews(schemaId, { introspection, role }) {
  const views = Object.fromEntries(
    introspection.classes
      .filter(cls => cls.relnamespace === schemaId && cls.relkind === "v")
      .map(view => [
        view.relname,
        {
          name: view.relname,
          // TODO: any other attributes specific to views? references? pseudo-FKs?
          columns: processColumns(view.oid, { introspection, role }),
          constraints: processReferences(view.oid, { introspection }),
          description: getDescription(view),
          permissions: getPermissions(view, { introspection, role }),
        },
      ]),
  );
  // console.log(...Object.values(views))
  return views;
}

/** @typedef {{
  name: string;
  columns: Record<string, DbColumn>;
  indexes: Record<string, DbIndex>;
  references: Record<string, DbReference>;
  permissions: Permissions;
  description: string | undefined;
}} DbTable */

/**
 * @param {string} schemaId
 * @param {{
    introspection: import("pg-introspection").Introspection,
    role: import("pg-introspection").PgRoles,
   }}
 * @returns {Record<string, DbTable>}
 */
function processTables(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.classes
      .filter(cls => cls.relnamespace === schemaId && cls.relkind === "r")
      .map(table => {
        const name = table.relname;
        const permissions = getPermissions(table, { introspection, role });
        const description = getDescription(table);
        const references = processReferences(table.oid, { introspection });
        const indexes = processIndexes(table.oid, { introspection });
        const columns = processColumns(table.oid, { introspection, role });
        return [name, { name, columns, indexes, references, permissions, description }];
      }),
  );
}

/** @typedef {{
  name: string;
  identity: string | null;
  type: string;
  nullable: boolean;
  generated: string | boolean;
  isArray: boolean;
  description: string | undefined;
  permissions: Permissions;
}} DbColumn */

/**
 * @param {string} tableId
 * @param {{
 *   introspection: import("pg-introspection").Introspection,
 *   role: import("pg-introspection").PgRoles,
 * }}
 * @returns {Record<string, DbColumn>}
 */
function processColumns(tableId, { introspection, role }) {
  return Object.fromEntries(
    introspection.attributes
      .filter(attr => attr.attrelid === tableId)
      .map(column => {
        const type = column.getType();
        invariant(type, `couldn't find type for column ${column.attname}`);
        const isArray = column.attndims && column.attndims > 0;
        const typeName = isArray ? getTypeName(type.getElemType()) : getTypeName(type);
        return [
          column.attname,
          {
            name: column.attname,
            identity: column.attidentity,
            type: typeName,
            nullable: !column.attnotnull,
            generated: column.attgenerated ? "STORED" : false,
            isArray,
            description: getDescription(column),
            // original: column,
            permissions: getPermissions(column, { introspection, role }),
          },
        ];
      }),
  );
}

/** @typedef {{
  name: string;
  colnames: Array<string>;
  isUnique: boolean | null;
  isPrimary: boolean | null;
  option: Readonly<Array<number>> | null;
  type: string
}} DbIndex */

/**
 * @param {string} tableId
 * @param {{
 *  introspection: import("pg-introspection").Introspection,
 * }}
 * @returns {Record<string, DbIndex>}
 */
function processIndexes(tableId, { introspection }) {
  return Object.fromEntries(
    introspection.indexes
      .filter(index => index.indrelid === tableId)
      .map(index => {
        const cls = index.getIndexClass();
        invariant(cls, `failed to find index class for index ${index.indrelid}`);

        const am = cls.getAccessMethod();
        invariant(am, `failed to find access method for index ${cls.relname}`);

        const keys = index.getKeys();
        invariant(keys, `failed to find keys for index ${cls.relname}`);

        const colnames = keys.filter(Boolean).map(a => a.attname);
        const name = cls.relname;
        // TODO: process index-specific options?
        const option = index.indoption;
        return [
          name,
          /** @type DbIndex */ ({
            name,
            isUnique: index.indisunique,
            isPrimary: index.indisprimary,
            option,
            type: am.amname,
            colnames,
          }),
        ];
      }),
  );
}

/** @typedef {{
  refPath: {
    schema: string;
    table: string;
    column: string;
  };
}} DbReference */

/**
 * @param {string} tableId
 * @param {{introspection: import("pg-introspection").Introspection}}
 * @returns {Record<string, DbReference>}
 */
function processReferences(tableId, { introspection }) {
  return Object.fromEntries(
    introspection.constraints
      .filter(c => c.conrelid === tableId && c.contype === "f")
      .map(constraint => {
        const fkeyAttr = constraint.getForeignAttributes();
        invariant(fkeyAttr, `failed to get foreign attributes for constraint ${constraint.conname}`);
        const fkeyClass = constraint.getForeignClass();
        invariant(fkeyClass, `failed to get foreign class for constraint ${constraint.conname}`);
        const fkeyNsp = fkeyClass?.getNamespace();
        invariant(fkeyNsp, `failed to get namespace for foreign class ${fkeyClass?.relname}`);
        const refPath = {
          schema: fkeyNsp?.nspname,
          table: fkeyClass?.relname,
          column: fkeyAttr?.[0].attname,
        };
        return [
          constraint.conname,
          {
            name: constraint.conname,
            refPath,
            // original: constraint,
          },
        ];
      }),
  );
}

/** @typedef {{
  permissions: Permissions;
  returnType: string | undefined;
  args: Array<[string | number, { type: string; hasDefault?: boolean }]>;
  volatility: "immutable" | "stable" | "volatile"
}} DbFunction */

/**
 * @param {string} schemaId
 * @param {{
     introspection: import("pg-introspection").Introspection,
     role: import("pg-introspection").PgRoles,
   }} _
 * @returns {Record<string, DbFunction>}
 */
function processFunctions(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.procs
      .filter(proc => proc.pronamespace === schemaId)
      .map(proc => {
        const type = proc.getReturnType();
        invariant(type, `couldn't find type for proc ${proc.proname}`);
        return [
          proc.proname,
          {
            permissions: getPermissions(proc, { introspection, role }),
            returnType: getTypeName(type),
            volatility: { i: "immutable", s: "stable", v: "volatile" }[proc.provolatile],
            // TODO: inflection?
            args: !proc.proargnames
              ? []
              : proc.getArguments().map((a, i) => {
                  /* not every argument is named! */
                  const argName = proc.proargnames?.[i] ?? i + 1;
                  return [
                    argName,
                    {
                      type: getTypeName(a.type),
                      hasDefault: a.hasDefault,
                    },
                  ];
                }),
          },
        ];
      }),
  );
}

/******************************************************************************/

/** @type {(opts?: {
  schemas?: Array<string>
  tables?: Array<string>
  inflections?: Inflections
  path?: string | ((o: { schema: string, name: string }) => string),
}) => Plugin} pluginOpts */
export const makeTypesPlugin = pluginOpts => ({
  name: "types",
  inflections: {
    types: ["classify"],
    columns: [],
  },
  render({ introspection, config, utils }) {
    const b = utils.builders;
    return Object.values(introspection.schemas)
      .filter(schema => pluginOpts?.schemas?.includes(schema.name) ?? true)
      .flatMap(schema => {
        const enums = Object.values(schema.types)
          .filter(t => t.kind === "enum")
          .map(t => {
            return b.exportNamedDeclaration.from({
              declaration: b.tsTypeAliasDeclaration.from({
                id: t.name,
                typeAnnotation: b.tsUnionType(t.values.map(v => b.literal(v))),
              }),
            });
          });

        const tables = Object.values(schema.tables)
          .filter(table => pluginOpts?.tables?.includes(table.name) ?? true)
          .map(table => {
            const identifier = config.inflections.types(table.name);
            const typeAlias = b.exportNamedDeclaration.from({
              comments: table.description
                ? [
                    b.commentBlock.from({
                      leading: true,
                      value: `* ${table.description} `,
                    }),
                  ]
                : null,
              declaration: b.tsTypeAliasDeclaration.from({
                id: b.identifier(identifier),
                typeAnnotation: b.tsTypeLiteral(
                  Object.values(table.columns).map(column => {
                    const type = utils.getASTTypeFromTypeName(
                      utils.getTSTypeNameFromPgType(column.type, config),
                    );
                    return b.tsPropertySignature.from({
                      comments: column.description
                        ? [b.commentBlock(`* ${column.description} `)]
                        : null,
                      key: b.identifier(config.inflections.columns(column.name)),
                      typeAnnotation: b.tsTypeAnnotation(
                        column.nullable ? b.tsUnionType([type, b.tsNullKeyword()]) : type,
                      ),
                    });
                  }),
                ),
              }),
            });
            return { identifier, typeAlias };
          });
        return [...tables, ...enums].map(({ identifier, typeAlias }) => ({
          path: makePathFromConfig({
            config: { ...config, pluginOpts },
            name: identifier,
            schema: schema.name,
          }),
          content: typeAlias,
          exports: [{ identifier, kind: "type" }],
        }));
      });
  },
});

/** @type {(pluginOpts?: {
  schemas?: Array<string>
  tables?: Array<string>
  path?: string | ((o: { schema: string, name: string }) => string),
  exportType?: boolean
}) => Plugin} */
export const makeZodSchemasPlugin = pluginOpts => ({
  name: "schemas",
  inflections: {
    types: ["camelize", "singularize"],
    schemas: ["camelize", "singularize"],
  },
  render({ introspection, config, utils }) {
    const b = utils.builders;
    return Object.values(introspection.schemas)
      .filter(s => pluginOpts?.schemas?.includes(s.name) ?? true)
      .flatMap(schema => {
        const tables = Object.values(schema.tables)
          .filter(table => pluginOpts?.tables?.includes(table.name) ?? true)
          .map(table => {
            const identifier = config.inflections.schemas(table.name);
            const exportType = b.exportNamedDeclaration(
              b.tsTypeAliasDeclaration.from({
                id: b.identifier(config.inflections.schemas(identifier)),
                typeAnnotation: b.tsExpressionWithTypeArguments(
                  b.tsQualifiedName(b.identifier("z"), b.identifier("infer")),
                  b.tsTypeParameterInstantiation([
                    b.tsTypeQuery(b.identifier(config.inflections.schemas(identifier))),
                  ]),
                ),
              }),
            );
            const zodSchema = b.exportNamedDeclaration(
              b.variableDeclaration("const", [
                b.variableDeclarator(
                  b.identifier(config.inflections.schemas(identifier)),
                  b.callExpression(
                    b.memberExpression(
                      b.callExpression(
                        b.memberExpression(b.identifier("z"), b.identifier("object")),
                        [
                          b.objectExpression(
                            Object.values(table.columns).map(c => {
                              const tsType = utils.getTSTypeNameFromPgType(c.type, config);
                              if (!tsType) {
                                c.type.split(".").reduce((p, c) => p[c], introspection);
                              }
                              const value = b.callExpression(
                                b.memberExpression(b.identifier("z"), b.identifier(tsType)),
                                [],
                              );
                              const typeModifiers = [
                                ...(c.nullable ? ["nullable"] : []),
                                ...({ "pg_catalog.uuid": ["uuid"] }[c.type] ?? []),
                              ].reduceRight(
                                (p, i) =>
                                  b.callExpression(b.memberExpression(p, b.identifier(i)), []),
                                value,
                              );
                              return b.objectProperty.from({
                                key: b.literal(config.inflections.columns(c.name)),
                                value: typeModifiers,
                              });
                            }),
                          ),
                        ],
                      ),
                      b.identifier("strict"),
                    ),
                    [],
                  ),
                ),
              ]),
            );
            return {
              content: pluginOpts?.exportType ? [zodSchema, exportType] : [zodSchema],
              identifier,
            };
          });

        return [
          ...tables,
          // TODO: ...views
        ].map(
          ({ identifier, content }) =>
            /** @type {Output} */ ({
              path: makePathFromConfig({
                config: { ...config, pluginOpts },
                name: config.inflections.schemas(identifier),
                schema: schema.name,
              }),
              content,
              imports: [{ identifier: "z", path: "zod" }],
              exports: [
                { identifier, kind: "zodSchema" },
                ...(pluginOpts?.exportType ? [{ identifier, kind: "type" }] : []),
              ],
            }),
        );
      });
  },
});

/** @typedef {{
  name: string;
  operation: "select" | "insert" | "update" | "delete" | "function"
  params: Record<string, { default?: any; type: string, Pick?: Array<string> }>;
  where?: Array<[string, string, string]>;
  join?: Array<string>;
  order?: Array<string>;
  returnType?: string;
  returnsMany?: boolean;
  schema: string;
  identifier: string;
}} QueryData */

// TODO: typescript optional? jsdoc setting?
/** @type {(opts: {
  schemas: Array<string>,
  tables?: Array<string>,
  path?: string | ((o: { schema: string, name: string }) => string),
}) => Plugin} pluginOpts */
export const makeQueriesPlugin = pluginOpts => ({
  name: "queries",
  inflections: {
    identifiers: ["camelize"],
    methods: ["camelize"],
  },
  render({ introspection, config, output, utils }) {
    if (!output) {
      throw new Error("makeQueriesPlugin must be placed after a plugin that exports a type");
    }
    return Object.values(introspection.schemas)
      .filter(schema => pluginOpts.schemas?.includes(schema.name) ?? true)
      .map(schema => {
        const tableNames = Object.keys(schema.tables).map(t => `${schema.name}.${t}`);
        const availableFunctions = Object.entries(schema.functions).filter(
          ([_, f]) => f.permissions.canExecute,
        );
        const [computed, procs] = partition(availableFunctions, ([_, fn]) => {
          if (fn.args.length !== 1) return false;
          if (fn.volatility === "volatile") return false;
          const firstArgType = fn.args[0]?.[1].type;
          const idx = tableNames.findIndex(tableName => firstArgType && firstArgType === tableName);
          return idx > -1;
        });
        const _computedByTables = Object.groupBy(computed, ([_, fn]) => fn.args[0][1].type);
        const _fnQueries = procs.map(
          ([name, fn]) =>
            /** @type QueryData */ ({
              name: config.inflections.methods(name),
              operation: "select",
              schema: schema.name,
              identifier: name,
            }),
        );

        const tables = Object.values(schema.tables)
          .filter(table => pluginOpts.tables?.includes(table.name) ?? true)
          .map(table =>
            Object.values(table.indexes).flatMap(index => {
              if (index.colnames.length > 1) {
                debug("queries plugin", `ignoring multi-column index ${index.name}`);
                return [];
              }
              const columns = Object.values(table.columns);
              const idxColumns = index.colnames.map(n => table.columns[n]);
              const identifier = table.name;
              const schemaName = schema.name;
              const returnType = config.inflections.types(table.name);
              const pgTypeName = utils.getTSTypeNameFromPgType(idxColumns.type, config);
              if (idxColumns.length > 1) {
                console.log(idxColumns);
              } else {
                const column = idxColumns[0];
                const columnName = config.inflections.columns(column.name);
                switch (true) {
                  case index.isPrimary:
                    return [
                      ...(!table.permissions.canSelect
                        ? []
                        : [
                            {
                              name: config.inflections.methods(`by_${idxColumns.name}`),
                              operation: "select",
                              where: [[column.name, "=", "?"]],
                              params: {
                                patch: {
                                  Pick: [columnName],
                                  type: config.inflections.types(table.name),
                                },
                              },
                              returnType,
                              returnsMany: false,
                              schema: schemaName,
                              identifier,
                            },
                          ]),
                      ...(!table.permissions.canInsert
                        ? []
                        : [
                            {
                              name: config.inflections.methods("create"),
                              operation: "insert",
                              params: {
                                patch: {
                                  type: config.inflections.types(table.name),
                                  Pick: columns
                                    .filter(c => c.permissions.canInsert)
                                    .map(c => config.inflections.columns(c.name)),
                                },
                              },
                              returnType,
                              returnsMany: false,
                              schema: schemaName,
                              identifier,
                            },
                          ]),
                      ...(!table.permissions.canUpdate
                        ? []
                        : [
                            {
                              name: config.inflections.methods("update"),
                              operation: "update",
                              where: [[columnName, "=", "?"]],
                              params: {
                                patch: {
                                  type: config.inflections.types(table.name),
                                  Pick: [
                                    columnName,
                                    ...columns
                                      .filter(c => c.permissions.canUpdate)
                                      .map(c => config.inflections.columns(c.name)),
                                  ],
                                },
                              },
                              returnsMany: false,
                              schema: schemaName,
                              identifier,
                            },
                          ]),
                      ...(!table.permissions.canDelete
                        ? []
                        : [
                            {
                              name: config.inflections.methods("delete"),
                              operation: "delete",
                              where: [[columnName, "=", "?"]],
                              params: {
                                patch: {
                                  Pick: [columnName],
                                  type: config.inflections.types(table.name),
                                },
                              },
                              returnsMany: false,
                              schema: schemaName,
                              identifier,
                            },
                          ]),
                    ];
                  case idxColumns.type === "pg_catalog.tsvector":
                    /** @type QueryData[] */
                    return [
                      {
                        name: config.inflections.methods("search"),
                        operation: "select",
                        join: ["lateral websearch_to_tsquery(?) as q"],
                        where: [[columnName, "@@", "q"]],
                        params: {
                          [columnName]: {
                            type: "text",
                          },
                        },
                        returnType,
                        returnsMany: true,
                        schema: schemaName,
                        identifier,
                      },
                    ];
                  case idxColumns.type === "pg_catalog.timestamptz":
                    const name =
                      idxColumns.name === "created_at" && index.option?.[0] === 3
                        ? "latest"
                        : `by_${columnName}`;
                    /** @type QueryData[] */
                    return [
                      {
                        name: config.inflections.methods(name),
                        operation: "select",
                        params: {
                          [columnName]: {
                            type: pgTypeName,
                          },
                        },
                        orderBy: [
                          columnName,
                          index.option && index.option[0] === 3 ? "desc" : "asc",
                        ],
                        returnType,
                        returnsMany: !index.isPrimary,
                        schema: schemaName,
                        identifier,
                      },
                    ];
                  default:
                    return utils.getOperatorsFrom({ column: idxColumns, index }).map(operator => ({
                      name: config.inflections.methods(`by_${columnName}`),
                      operation: "select",
                      where: [[columnName, operator, "?"]],
                      params: {
                        patch: {
                          type: config.inflections.types(table.name),
                          Pick: [columnName],
                        },
                      },
                      returnType,
                      returnsMany: !(index.isUnique || index.isPrimary),
                      schema: schemaName,
                      identifier,
                    }));
                }
              }
            }),
          );
        return tables;
      })
      .flatMap(q => {
        return q
          .filter(q => q?.length)
          .flatMap(queryData => {
            const { identifier, schema } = queryData[0];
            const typeRef = utils.findExports({
              output,
              identifier: config.inflections.types(identifier),
              kind: "type",
            });
            const exportPath = makePathFromConfig({
              config: { ...config, pluginOpts },
              name: config.inflections.identifiers(identifier),
              schema,
            });
            const exportSpec = {
              identifier: config.inflections.identifiers(identifier),
              kind: Object.fromEntries(
                queryData.map(q => [q.name, () => ({ name: identifier, queryData })]),
              ),
            };
            return /** @type {Output} */ ({
              path: exportPath,
              imports: [
                config.adapter === "pg"
                  ? {
                      identifier: "pg",
                      typeImport: true,
                      default: true,
                      path: "pg",
                    }
                  : {
                      identifier: "Sql",
                      // typeImport: true,
                      default: false,
                      path: "postgres",
                    },
                typeRef.path === exportPath ? undefined : typeRef,
              ].filter(Boolean),
              exports: [exportSpec],
              content: queryDataToObjectMethodsAST({
                queryData,
                name: identifier,
                inflections: config.inflections,
                adapter: config.adapter,
              }),
            });
          });
      });
  },
});

/** @param {QueryData} queryData
 * @returns {{query: string, params: Array<string>}}
 */
function queryBuilder(queryData) {
  const target = `${queryData.schema}.${queryData.identifier}`;
  /** @type {Array<string>} */
  const params = [];
  const query = (() => {
    const patch = ("patch" in queryData.params && queryData.params.patch.Pick) || null;
    switch (queryData.operation) {
      case "select": {
        if (queryData.where) params.push(...queryData.where.map(([v]) => v));
        if (queryData.order) params.push(...queryData.order.map(([v]) => v));
        if (queryData.returnsMany) params.push("offset", "limit");
        return [
          "select",
          "*",
          "from",
          target,
          queryData.join,
          queryData.where && `where ${queryData.where.map(p => p.join(" ")).join(" and ")}`,
          queryData.order && `order by ${queryData.order.join(" ")}`,
          queryData.returnsMany && "offset ? fetch first ? rows only",
        ];
      }
      case "insert": {
        const columns = (patch || Object.keys(queryData.params)).join(", ");
        const values = (patch || queryData.params).map(() => "?").join(", ");
        params.push(...(patch || Object.keys(queryData.params)));
        return [`insert into ${target}`, `(${columns}) values (${values})`, "returning *"];
      }
      case "update": {
        const values = patch
          ? patch.map(key => `${key} = ?`).join(", ")
          : Object.keys(queryData.params)
              .map(name => `${name} = ?`)
              .join(", ");
        params.push(...(patch || Object.keys(queryData.params)));
        params.push(...queryData.where.map(([v]) => v));
        return [
          `update ${target}`,
          `set ${values}`,
          queryData.where && `where ${queryData.where.map(p => p.join(" ")).join(" and ")}`,
        ];
      }
      case "delete": {
        params.push(...queryData.where.map(([v]) => v));
        return [
          `delete from ${target}`,
          queryData.where && `where ${queryData.where.map(p => p.join(" ")).join(" and ")}`,
        ];
      }
      default:
        throw new Error(`unknown queryData operation "${queryData.operation}"`);
    }
  })()
    .filter(Boolean)
    .join(" ");
  return { query, params };
}

// TODO: alternative styles? what about just exporting functions?
/** @param {{
  queryData: Array<QueryData>;
  name: string;
  adapter: Config['adapter']
  inflections: Inflections
}} _ */
function queryDataToObjectMethodsAST({ queryData, name, inflections, adapter }) {
  const b = recast.types.builders;

  return b.exportNamedDeclaration(
    b.variableDeclaration("const", [
      b.variableDeclarator(
        b.identifier(inflections.identifiers(name)),
        b.objectExpression(
          queryData.map(queryData => {
            const [[Pick], params] = partition(
              Object.entries(queryData.params),
              ([name, values]) => name === "patch" && "Pick" in values,
            );
            const typeParamAst = params.map(([name, { default: hasDefault, type }]) =>
              b.tsPropertySignature.from({
                key: b.identifier(name),
                optional: hasDefault != null,
                typeAnnotation: b.tsTypeAnnotation(
                  typeof type === "string" ? utils.getASTTypeFromTypeName(type) : type,
                ),
              }),
            );
            return b.objectMethod.from({
              kind: "method",
              async: true,
              key: b.identifier(queryData.name),
              params: [
                b.objectPattern.from({
                  properties: Object.entries(queryData.params).flatMap(([name, v]) => {
                    if (name === "patch" && "Pick" in v && v.Pick) {
                      return v.Pick.map(key =>
                        b.property.from({
                          kind: "init",
                          key: b.identifier(key),
                          shorthand: true,
                          value: b.identifier(key),
                        }),
                      );
                    }
                    return b.property.from({
                      kind: "init",
                      key: b.identifier(name),
                      value:
                        v.default != null && v.default !== ""
                          ? b.assignmentPattern(b.identifier(name), b.literal(v.default))
                          : b.identifier(name),
                      shorthand: true,
                    });
                  }),
                  typeAnnotation: Pick?.[1].Pick
                    ? b.tsTypeAnnotation(
                        b.tsIntersectionType([
                          b.tsTypeReference(
                            b.identifier("Pick"),
                            b.tsTypeParameterInstantiation([
                              b.tsTypeReference(b.identifier(Pick[1].type)),
                              b.tsUnionType(
                                Pick[1].Pick.map(key => b.tsLiteralType(b.stringLiteral(key))),
                              ),
                            ]),
                          ),
                          ...(typeParamAst.length ? [b.tsTypeLiteral(typeParamAst)] : []),
                        ]),
                      )
                    : typeParamAst.length
                      ? b.tsTypeAnnotation(b.tsTypeLiteral(typeParamAst))
                      : undefined,
                }),
                adapter === "pg"
                  ? b.identifier.from({
                      name: "pool",
                      typeAnnotation: b.tsTypeAnnotation(
                        b.tsUnionType([
                          b.tsTypeReference(
                            b.tsQualifiedName(b.identifier("pg"), b.identifier("Client")),
                          ),
                          b.tsTypeReference(
                            b.tsQualifiedName(b.identifier("pg"), b.identifier("Pool")),
                          ),
                        ]),
                      ),
                    })
                  : b.identifier.from({
                      name: "sql",
                      typeAnnotation: b.tsTypeAnnotation(b.tsTypeReference(b.identifier("Sql"))),
                    }),
              ],
              body: {
                pg() {
                  const { query, params } = queryBuilder(queryData);
                  const queryStr = query.split("?").reduce((acc, part, i) => {
                    if (i === 0) return `${acc}${part}`;
                    return `${acc}$${i}${part}`;
                  }, "");
                  const queryExpression = b.awaitExpression(
                    b.callExpression.from({
                      callee: b.memberExpression(b.identifier("pool"), b.identifier("query")),
                      typeArguments: queryData.returnType
                        ? b.typeParameterInstantiation([b.typeParameter(queryData.returnType)])
                        : null,
                      arguments: [
                        b.stringLiteral(queryStr),
                        b.arrayExpression(params.map(argName => b.identifier(argName))),
                      ],
                    }),
                  );
                  if (!queryData.returnType) {
                    return b.blockStatement([b.returnStatement(queryExpression)]);
                  }

                  return b.blockStatement([
                    b.variableDeclaration("const", [
                      b.variableDeclarator(b.identifier("result"), queryExpression),
                    ]),
                    b.returnStatement(
                      queryData.returnsMany
                        ? b.memberExpression(b.identifier("result"), b.identifier("rows"))
                        : b.memberExpression(
                            b.memberExpression(b.identifier("result"), b.identifier("rows")),
                            b.literal(0),
                          ),
                    ),
                  ]);
                },
                postgres() {
                  const { query, params } = queryBuilder(queryData);
                  const queryStr = query
                    .split("?")
                    .map(
                      (part, i) =>
                        i === 0
                          ? b.templateElement({ raw: part, cooked: part }, false)
                          : b.templateElement({ raw: part, cooked: part }, true),
                      "",
                    );
                  const queryExpression = b.awaitExpression(
                    b.taggedTemplateExpression(
                      b.tsInstantiationExpression.from({
                        expression: b.identifier("sql"),
                        typeParameters: !queryData.returnType
                          ? null
                          : b.tsTypeParameterInstantiation([
                              b.tsTypeReference(
                                b.identifier("Array"),
                                b.tsTypeParameterInstantiation([
                                  b.tsTypeReference(b.identifier(queryData.returnType)),
                                ]),
                              ),
                            ]),
                      }),
                      b.templateLiteral(
                        queryStr,
                        params.map(name => b.identifier(name)),
                      ),
                    ),
                  );
                  if (!queryData.returnType) {
                    return b.blockStatement([b.returnStatement(queryExpression)]);
                  }

                  return b.blockStatement([
                    b.variableDeclaration("const", [
                      b.variableDeclarator(b.identifier("result"), queryExpression),
                    ]),
                    b.returnStatement(
                      queryData.returnsMany
                        ? b.identifier("result")
                        : b.memberExpression(b.identifier("result"), b.literal(0)),
                    ),
                  ]);
                },
              }[adapter](),
            });
          }),
        ),
      ),
    ]),
  );
}

/** @type {() => Plugin} */
export const makeHttpPlugin = () => ({
  name: "http",
  inflections: {
    endpoints: ["underscore"],
  },
  render({ output }) {
    const r = output?.flatMap(r => r?.exports ?? []);
    const api = r
      .filter(
        e =>
          typeof e.kind === "object" && Object.values(e.kind).every(k => typeof k === "function"),
      )
      .map(({ identifier: route, kind: endpoints }) => {
        const e = Object.entries(endpoints).map(([name, fn]) => [name, fn()]);
        // console.log(route, e);
        return e;
      });
    return [];
  },
});

/** @param {{ output: Array<Output>, identifier: string, kind: Output['exports']['kind'] }} _ */
function findExports({ output, identifier, kind }) {
  for (let i = 0; i < output.length; i++) {
    const r = output[i];
    if (!r) continue;
    const e = r.exports?.find(e => e.kind === kind && e.identifier === identifier);
    if (e) {
      /** @type {ImportSpec} */
      return { identifier: e.identifier, path: r.path, typeImport: kind === "type" };
    }
  }
  console.log(output.flatMap(e => e.exports));
  throw new Error(`could not type export for ${identifier}`);
}

// TODO: not handled: import <default>, { [type] <named> } from '<path>'
/** @param {Array<ImportSpec>} deps */
function parseDependencies(deps) {
  const b = recast.types.builders;
  return Object.values(Object.groupBy(deps, d => d.path)).map(dep => {
    const ids = Object.groupBy(dep, d => d.identifier);
    if (dep.length > 1 && Object.keys(ids).length > 1) {
      const allTypes = dep.every(d => d.typeImport);
      return b.importDeclaration.from({
        importKind: allTypes ? "type" : "value",
        specifiers: dep.map(d =>
          b.importSpecifier.from({
            imported: b.identifier(d.identifier),
          }),
        ),
        source: b.literal(dep[0].path),
      });
    }
    const [d] = dep;
    return b.importDeclaration.from({
      importKind: d.typeImport ? "type" : "value",
      specifiers: d.default
        ? [b.importDefaultSpecifier(b.identifier(d.identifier))]
        : [b.importSpecifier(b.identifier(d.identifier))],
      source: b.literal(d.path),
    });
  });
}

/**
 * @param {Config} config
 * @returns {Config}
 */
export function defineConfig(config) {
  return config;
}

/** @param {string} type */
function getASTTypeFromTypeName(type) {
  const b = recast.types.builders;
  switch (type) {
    case "string":
      return b.tsStringKeyword();
    case "boolean":
      return b.tsBooleanKeyword();
    case "Date":
      return b.tsTypeReference(b.identifier("Date"));
    case "number":
      return b.tsNumberKeyword();
    case "unknown":
      return b.tsUnknownKeyword();
    // case "array":
    //   return b.tsArrayType(b.tsStringKeyword());
    default:
      debug(`unknown type "${type}"`);
      return b.tsUnknownKeyword();
  }
}

/**
 * @param {string} pgTypeString
 * @param {Config} config
 * @returns {"string" | "boolean" | "number" | "Date" | "unknown"}
 */
function getTSTypeNameFromPgType(pgTypeString, config) {
  switch (pgTypeString) {
    case "pg_catalog.int2":
    case "pg_catalog.int4":
    case "pg_catalog.float4":
    case "pg_catalog.float8":
      return "number";
    case "pg_catalog.int8":
    case "pg_catalog.numeric":
    case "pg_catalog.char":
    case "pg_catalog.bpchar":
    case "pg_catalog.varchar":
    case "pg_catalog.text":
    case "pg_catalog.uuid":
    case "pg_catalog.inet":
    case "pg_catalog.int4range":
    case "pg_catalog.int8range":
    case "pg_catalog.numrange":
    case "pg_catalog.tsrange":
    case "pg_catalog.tstzrange":
    case "pg_catalog.daterange":
      return "string";
    case "pg_catalog.bool":
      return "boolean";
    case "pg_catalog.date":
    case "pg_catalog.time":
    case "pg_catalog.timetz":
    case "pg_catalog.timestamp":
    case "pg_catalog.timestamptz":
      return "Date";
    case "pg_catalog.json":
    case "pg_catalog.jsonb":
      return "unknown";
    default:
      if (config.typeMap && pgTypeString in config.typeMap) {
        return config.typeMap[pgTypeString];
      }
      debug(`unknown PgTypeString "${pgTypeString}"`);
      return null;
  }
}

/** @param {{ index: DbIndex, column: DbColumn }} + */
function getOperatorsFrom({ column, index }) {
  switch (true) {
    case column.type === "pg_catalog.tsvector":
      return ["@@"];
    case Boolean(column.isArray && index.type === "gin"):
      return ["@>"];
    case column.type === "pg_catalog.timestamptz" && index.type === "btree":
      return ["=", "<", ">", "<=", ">=", "between"];
    default:
      return ["="];
  }
}

/** @param {{
  config: Config & { pluginOpts: {path: unknown} }
  schema: string
  name: string
}} _ */
function makePathFromConfig({ config, schema, name }) {
  switch (true) {
    case typeof config.pluginOpts.path === "function":
      return config.pluginOpts.path({ schema, name }).concat(`.${config.outputExtension}`);

    case typeof config.pluginOpts.path === "string":
      return config.pluginOpts.path.concat(`.${config.outputExtension}`);

    case config.pluginOpts.path instanceof Array &&
      config.pluginOpts.path.every(x => typeof x === "string"):
      return transform(name, config.pluginOpts.path).concat(`.${config.outputExtension}`);

    default:
      return `./${name}.${config.outputExtension}`;
  }
}

/** @param {any} data */
function stringify(data) {
  return JSON.stringify(
    data,
    (_key, value) => {
      const type = Object.prototype.toString.call(value).slice(8, -1);
      switch (true) {
        case type.endsWith("Function"):
          return `[${type}]`;
        default:
          return value;
      }
    },
    2,
  );
}

export { transform } from "inflection";
