#!/usr/bin/env node
import path from "path";
import _debug from "debug";
import fs from "fs/promises";
import { transform } from "inflection";
import {
  type PgType,
  type PgRoles,
  type PgNamespace,
  type Introspection as PgIntrospection,
  entityPermissions,
  makeIntrospectionQuery,
  parseIntrospectionResults,
} from "pg-introspection";
import recast from "recast";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";

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
                      const [values, types] = partition([e => e.kind === "type"], entries);
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

type Config = z.infer<typeof userConfig>;
type Inflections = z.infer<typeof inflectionsSchema>;

export default async function parseConfig(): Promise<Config> {
  let configSearch = await cosmiconfig("pgsourcerer").search();
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

type ImportSpec = { typeImport?: boolean; identifier: string; default?: boolean; path: string };

type Output = ReturnType<Config["plugins"][number]["render"]>[number];

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

type Plugin = {
  name: string;
  inflections?: Inflections;
  render(info: {
    introspection: { schemas: Record<string, DbSchema> };
    output: Array<Output> | null;
    config: Config;
    utils: typeof utils;
  }): Array<Output>;
};

async function main(): Promise<void> {
  const config = await parseConfig();
  const introspectionResult = await (async () => {
    const query = makeIntrospectionQuery();
    switch (config.adapter) {
      case "pg": {
        const { default: pg } = await import("pg");
        const pool = new pg.Pool({ connectionString: config.connectionString });
        const client = await pool.connect();
        await client.query("begin");
        if (config.role) {
          await client.query("select set_config('role', $1, false)", [config.role]);
        }
        const { rows } = await client.query(query);
        await client.query("rollback");
        client.release();
        pool.end();
        return rows[0].introspection;
      }
      case "postgres": {
        const { default: postgres } = await import("postgres");
        const sql = postgres(config.connectionString);
        const result = await sql.begin(async sql => {
          if (config.role) {
            await sql`select set_config('role', ${config.role}, false)`;
          }
          const rows = await sql.unsafe(query);
          sql.unsafe("rollback");
          return rows[0].introspection;
        });
        sql.end();
        return result;
      }
      default:
        console.error(`invalid adapter in config: ${config.adapter}`);
        process.exit(1);
    }
  })();

  if (!("plugins" in config)) {
    console.error("no plugins defined, nothing to do");
    return process.exit(0);
  }

  const introspection = processIntrospection(parseIntrospectionResults(introspectionResult, true));

  const output: null | Array<Output> = pluginRunner(config, introspection);

  if (!output || !output.length) {
    console.error("no output from plugins");
    return process.exit(1);
  }

  Object.entries(groupBy(o => o.path, output)).forEach(async ([strPath, files]) => {
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

function pluginRunner(config: Config, introspection: Introspection) {
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
  return config.plugins.reduce(
    (prevOutput, plugin) => {
      const newOutput = plugin.render({
        introspection,
        output: prevOutput,
        config,
        utils,
      });
      return prevOutput ? prevOutput.concat(newOutput) : newOutput;
    },
    null as null | Array<Output>,
  );
}

function getTypeName(type: PgType) {
  return [type.getNamespace()?.nspname, type.typname].join(".");
}

function getDescription(entity: { getDescription(): string | undefined }) {
  return entity.getDescription();
}

type Introspection = { name: string; schemas: Record<string, DbSchema> };

function processIntrospection(introspection: PgIntrospection): Introspection {
  const role = introspection.getCurrentUser();
  if (!role) throw new Error("who am i???");
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

function getPermissions(
  entity: Parameters<typeof entityPermissions>[1],
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): {
  canSelect?: boolean;
  canInsert?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  canExecute?: boolean;
} {
  // licensed under MIT from Benjie Gillam
  // https://github.com/graphile/crystal/blob/9d1c54a28e29a2da710ba093541b4a03bab6b5c6/graphile-build/graphile-build-pg/src/plugins/PgRBACPlugin.ts
  switch (entity._type) {
    case "PgAttribute": {
      const table = entity.getClass();
      if (!table) throw new Error(`couldn't find table for attribute ${entity.attname}`);
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
      throw new Error(`unknown entity type "${entity._type}"`);
  }
}
type Permissions = ReturnType<typeof getPermissions>;

type DbSchema = {
  name: string;
  views: Record<string, DbView>;
  tables: Record<string, DbTable>;
  functions: Record<string, DbFunction>;
  types: Record<string, DbType>;
};

function processSchema(
  schema: PgNamespace,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): DbSchema {
  return {
    name: schema.nspname,
    views: processViews(schema.oid, { introspection, role }),
    tables: processTables(schema.oid, { introspection, role }),
    functions: processFunctions(schema.oid, { introspection, role }),
    types: processTypes(schema.oid, { introspection, role }),
    // permissions: getPermissions(schema, { introspection, role }),
  };
}

function processTypes(
  schemaId: string,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
) {
  void fs.writeFile("types.json", stringify(introspection.types), "utf8");
  const domains = introspection.types
    .filter(t => t.typtype === "d" && t.typnamespace === schemaId)
    .map(t => ({ name: t.typname, kind: "domain", type: t.typoutput }));

  const enums = introspection.types
    .filter(t => t.typtype === "e" && t.typnamespace === schemaId)
    .map(t => {
      const values = t.getEnumValues();
      if (!values) throw new Error("could not find enum values for ${t.typname}");
      return {
        name: t.typname,
        kind: "enum",
        values: values.map(x => x.enumlabel),
      };
    });

  const composites = introspection.classes
    .filter(cls => cls.relnamespace === schemaId && cls.relkind === "c")
    .map(t => ({
      name: t.relname,
      kind: "composite",
      values: t.getAttributes().map(a => {
        const type = a.getType();
        if (!type) throw new Error(`could not find type for composite attribute ${t.relname}`);
        return { name: a.attname, type: getTypeName(type) };
      }),
    }));

  const types = groupWith(
    (a, b) => {
      if (a) throw new Error(`existing type with name ${a.name}`);
      return b;
    },
    t => t.name,
    [...domains, ...enums, ...composites],
  );
  return types as Array<
    | { kind: "domain"; name: string; type: "text" }
    | { kind: "enum"; name: string; values: Array<string> }
    | { composite: "enum"; name: string; type: Array<{ name: string; type: string }> }
  >;
}

type DbView = {
  name: string;
  columns: Record<string, DbColumn>;
  constraints: Record<string, DbReference>;
  description: string | undefined;
  permissions: Permissions;
};

function processViews(
  schemaId: string,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): Record<string, DbView> {
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

type DbTable = {
  name: string;
  columns: Record<string, DbColumn>;
  indexes: Record<string, DbIndex>;
  references: Record<string, DbReference>;
  permissions: Permissions;
  description: string | undefined;
};

function processTables(
  schemaId: string,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): Record<string, DbTable> {
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

type DbColumn = {
  name: string;
  identity: string | null;
  type: string;
  nullable: boolean;
  generated: string | boolean;
  isArray: boolean;
  description: string | undefined;
  permissions: Permissions;
};

function processColumns(
  tableId: string,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): Record<string, DbColumn> {
  return Object.fromEntries(
    introspection.attributes
      .filter(attr => attr.attrelid === tableId)
      .map(column => {
        const type = column.getType();
        if (!type) throw new Error(`couldn't find type for column ${column.attname}`);
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

type DbIndex = {
  name: string;
  colnames: Array<string>;
  isUnique: boolean | null;
  isPrimary: boolean | null;
  option: Readonly<Array<number>> | null;
  kind: string | null;
};

function processIndexes(
  tableId: string,
  {
    introspection,
  }: {
    introspection: PgIntrospection;
  },
): Record<string, DbIndex> {
  return Object.fromEntries(
    introspection.indexes
      .filter(index => index.indrelid === tableId)
      .map(index => {
        const cls = index.getIndexClass();
        if (!cls) throw new Error(`failed to find index class for index ${index.indrelid}`);

        const am = cls.getAccessMethod();
        if (!am) throw new Error(`failed to find access method for index ${cls.relname}`);

        const keys = index.getKeys();
        if (!keys) throw new Error(`failed to find keys for index ${cls.relname}`);

        const colnames = keys.filter(Boolean).map(a => a.attname);
        const name = cls.relname;
        // TODO: process index-specific options?
        const option = index.indoption;
        return [
          name,
          {
            name,
            isUnique: index.indisunique,
            isPrimary: index.indisprimary,
            option,
            kind: am.amname,
            colnames,
          } satisfies DbIndex,
        ];
      }),
  );
}

type DbReference = {
  refPath: {
    schema: string;
    table: string;
    column: string;
  };
};

function processReferences(
  tableId: string,
  { introspection }: { introspection: PgIntrospection },
): Record<string, DbReference> {
  return Object.fromEntries(
    introspection.constraints
      .filter(c => c.conrelid === tableId && c.contype === "f")
      .map(constraint => {
        const fkeyAttr = constraint.getForeignAttributes();
        if (!fkeyAttr) throw new Error();
        const fkeyClass = constraint.getForeignClass();
        if (!fkeyClass) throw new Error();
        const fkeyNsp = fkeyClass?.getNamespace();
        if (!fkeyNsp) throw new Error();
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

type DbFunction = {
  permissions: Permissions;
  returnType: string | undefined;
  args: Array<[string | number, { type: string; hasDefault?: boolean }]>;
  volatility: "immutable" | "stable" | "volatile";
};

function processFunctions(
  schemaId: string,
  {
    introspection,
    role,
  }: {
    introspection: PgIntrospection;
    role: PgRoles;
  },
): Record<string, DbFunction> {
  return Object.fromEntries(
    introspection.procs
      .filter(proc => proc.pronamespace === schemaId)
      .map(proc => {
        const type = proc.getReturnType();
        if (!type) throw new Error(`couldn't find type for proc ${proc.proname}`);
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

export const makeTypesPlugin = (pluginOpts?: {
  schemas?: Array<string>;
  tables?: Array<string>;
  inflections?: Inflections;
  path?: string | ((o: { schema: string; name: string }) => string);
}): Plugin => ({
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

export const makeZodSchemasPlugin = (pluginOpts?: {
  schemas?: Array<string>;
  tables?: Array<string>;
  path?: string | ((o: { schema: string; name: string }) => string);
  exportType?: boolean;
}): Plugin => ({
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
        ].map(({ identifier, content }) => ({
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
        } satisfies Output));
      });
  },
});

export const makeEffectClassPlugin = (pluginOpts: {
  schemas: Array<string>;
  tables?: Array<string>;
  path?: string | ((o: { schema: string; name: string }) => string);
}): Plugin => ({
  name: "effectClass",
  inflections: {
    schemas: ["camelize", "singularize"],
  },
  render({ introspection, config, output, utils }) {
    // class User extends Schema.Class("User")({
    //   id: Schema.String,
    //   name: Schema.String
    // }) {}
    const b = utils.builders;
    return Object.values(introspection.schemas)
      .flatMap(schema => {
        const tables = Object.values(schema.tables).map(t => {
          const identifier = config.inflections.tables(t.name);
          b.classDeclaration.from({
            id: b.identifier(identifier),
            superClass: b.callExpression.from({
              callee: b.callExpression.from({
                callee: b.memberExpression(b.identifier("Schema"), b.identifier("Class")),
                typeArguments: b.typeParameterInstantiation([b.typeParameter(identifier)]),
                arguments: [b.literal(identifier)],
              }),
              arguments: [
                b.objectExpression.from({
                  properties: Object.values(t.columns).map(c => {
                    const identifier = config.inflections.columns(c.name);
                    return b.property.from({
                      kind: "init",
                      key: b.stringLiteral(identifier),
                      value: b.memberExpression(b.identifier("Schema"), b.identifier(schemaType)),
                    });
                  }),
                }),
              ],
            }),
            body: b.classBody.from({
              body: [],
            }),
          });
        });
        return tables;
      })
      .map(({ identifier, content }) => /** @type {Output} */ ({
        path: makePathFromConfig({
          config: { ...config, pluginOpts },
          name: config.inflections.schemas(identifier),
          schema: schema.name,
        }),
        content,
        imports: [{ identifier: "Schema", path: "effect" }],
        exports: [{ identifier, kind: "effectClass" }],
      }));
  },
});

type QueryData = {
  name: string;
  operation: "select" | "insert" | "update" | "delete" | "function";
  params: Record<string, { default?: any; type: string; Pick?: Array<string> }>;
  where?: Array<[string, string, string]>;
  join?: Array<string>;
  order?: Array<string>;
  returnType?: string;
  returnsMany?: boolean;
  schema: string;
  identifier: string;
};

// TODO: typescript optional? jsdoc setting?
export const makeQueriesPlugin = (pluginOpts: {
  schemas: Array<string>;
  tables?: Array<string>;
  path?: string | ((o: { schema: string; name: string }) => string);
}): Plugin => ({
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
        const [computed, procs] = partition(
          [
            ([_, fn]) => {
              if (fn.args.length !== 1) return false;
              if (fn.volatility === "volatile") return false;
              const firstArgType = fn.args[0]?.[1].type;
              const idx = tableNames.findIndex(
                tableName => firstArgType && firstArgType === tableName,
              );
              return idx > -1;
            },
          ],
          availableFunctions,
        );
        const computedByTables = groupBy(([_, fn]) => fn.args[0][1].type, computed);
        // console.log(procs, schema.views);
        const fnQueries = procs.map(([name, fn]) => /** @type QueryData */ ({
          name: config.inflections.methods(name),
          operation: "select",
          schema: schema.name,
          identifier: name,
        }));
        /** @type QueryData[][] */
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
            return /** @type {Output} */ {
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
            };
          });
      });
  },
});

function queryBuilder(queryData: QueryData): { query: string; params: Array<string> } {
  const target = `${queryData.schema}.${queryData.identifier}`;
  const params: Array<string> = [];
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
function queryDataToObjectMethodsAST({
  queryData,
  name,
  inflections,
  adapter,
}: {
  queryData: Array<QueryData>;
  name: string;
  adapter: Config["adapter"];
  inflections: Inflections;
}) {
  const b = recast.types.builders;

  return b.exportNamedDeclaration(
    b.variableDeclaration("const", [
      b.variableDeclarator(
        b.identifier(inflections.identifiers(name)),
        b.objectExpression(
          queryData.map(queryData => {
            const [[Pick], params] = partition(
              [([name, values]) => name === "patch" && "Pick" in values],
              Object.entries(queryData.params),
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

export const makeHttpPlugin = (): Plugin => ({
  name: "http",
  inflections: {
    endpoints: ["underscore"],
  },
  render({ output }) {
    const api = output
      ?.flatMap(r => r?.exports ?? [])
      .filter(
        e =>
          typeof e.kind === "object" && Object.values(e.kind).every(k => typeof k === "function"),
      )
      .map(({ identifier: route, kind: endpoints }) => {
        const e = Object.entries(endpoints).map(([name, fn]) => [name, fn()]);
        // console.log(route, e);
        return e;
      });
    return api;
  },
});

function findExports({
  output,
  identifier,
  kind,
}: {
  output: Array<Output>;
  identifier: string;
  kind: Output["exports"]["kind"];
}) {
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
function parseDependencies(deps: Array<ImportSpec>) {
  const b = recast.types.builders;
  return Object.values(groupBy(d => d.path, deps)).map(dep => {
    const ids = groupBy(d => d.identifier, dep);
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

export function defineConfig(config: Config): Config {
  return config;
}

function getASTTypeFromTypeName(type: string) {
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

function getTSTypeNameFromPgType(
  pgTypeString: string,
  config: Config,
): "string" | "boolean" | "number" | "Date" | "unknown" {
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

function getOperatorsFrom({ column, index }: { index: DbIndex; column: DbColumn }) {
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

function makePathFromConfig({
  config,
  schema,
  name,
}: {
  config: Config & { pluginOpts: { path: unknown } };
  schema: string;
  name: string;
}) {
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

function stringify(data: unknown) {
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

function groupWith<Output, Input, Key>(
  valTransform: (prev: Output, value: Input) => Output,
  keyMaker: (o: Input) => Key,
  values: Array<Input>,
) {
  const result = /** @type Record<Key, Output> */ {};
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    const key = keyMaker(val);
    result[key] = valTransform(result[key], val);
  }
  return result;
}

function groupBy<T, K>(keyMaker: (a: T) => K, values: Array<T>) {
  return groupWith(
    (b, a) => {
      let r = b ?? [];
      r.push(a);
      return r;
    },
    keyMaker,
    values,
  );
}

function partition<T>(predicates: Array<(a: T) => boolean>, values: Array<T>): Array<Array<T>> {
  const result = /** @type {Array<Array<T>>} */ predicates.map(() => []).concat([[]]);
  const stack = values.slice(0);
  let value;
  while (stack.length) {
    value = stack.pop();
    if (value == null) break;
    // @ts-expect-error  I promise it's fine
    result.at(predicates.findIndex(p => p(value))).push(value);
  }
  return result;
}

export { transform } from "inflection";
