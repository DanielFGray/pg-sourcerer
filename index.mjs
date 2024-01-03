// @ts-check
import path from "path";
import _debug from "debug";
import fs from "fs/promises";
import { camelize, singularize } from "inflection";
// @ts-check
import {
  entityPermissions,
  makeIntrospectionQuery,
  parseIntrospectionResults,
} from "pg-introspection";
import recast from "recast";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";

const debug = _debug("pg-sourcerer");

/** @param {string} str */
const camelCase = (str) => camelize(str, true);

/** @param {string} str */
const PascalCase = (str) => camelize(str, false);

export const userConfig = z.object({
  connectionString: z.string(),
  adapter: z.union([z.literal("pg"), z.literal("postgres")]),
  outputDir: z.string(),
  inflections: z
    .object({
      tableNames: z.function().args(z.string()).returns(z.string()).optional(),
      columnNames: z.function().args(z.string()).returns(z.string()).optional(),
    })
    .optional(),
  typeMap: z.record(z.string()).optional(),
  plugins: z.array(
    z.function().returns(
      z.array(
        z.object({
          content: z.any(), // ast builder can take care of itself
          path: z.string(),
          exports: z
            .array(
              z
                .object({
                  kind: z.union([z.literal("type"), z.literal("zod")]),
                  identifier: z.string(),
                })
                .strict(),
            )
            .optional(),
          imports: z
            .array(
              z.object({
                typeImport: z.boolean().optional(),
                identifier: z.string(),
                default: z.boolean().optional(),
                path: z.string(),
              }).strict(),
            ).optional(),
        }),
      ),
    ),
  ),
  role: z.string().optional(),
});

/** @typedef {z.infer<typeof userConfig>} UserConfig */
/** @typedef {UserConfig & { inflections: Required<NonNullable<UserConfig['inflections']>> }} Config */

export async function parseConfig() {
  let configSearch = await cosmiconfig("pgsourcerer").search();
  if (!configSearch) {
    // TODO what if we codegen an empty config
    console.error("a sourcerer config is required");
    process.exit(1);
  }
  let config;
  try {
    config = userConfig.parse(configSearch.config);
  } catch (e) {
    if (e instanceof z.ZodError) {
      console.error(e.format());
    } else {
      console.error(e);
    }
    process.exit(1);
  }

  config.inflections = Object.assign(
    {
      tableNames: (t) => PascalCase(singularize(t)),
      columnNames: (t) => t,
    },
    config.inflections ?? {},
  );

  return config;
}

/** @param {any} data */
function serialize(data) {
  return JSON.stringify(data, (key, value) => {
    const type = Object.prototype.toString.call(value).slice(8, -1);
    switch (true) {
      case type.endsWith("Function"):
        return `[${type}]`;
      default:
        return value;
    }
  });
}

/**
 * @template T
 * @template {string} K
 * @param {Array<T>} values
 * @param {(a: T) => K} keyFinder
 */
// function groupBy<T, K extends string>(values: Array<T>, keyFinder: (a: T) => K): Record<string, Array<T>> {
function groupBy(values, keyFinder) {
  const result = /** @@type Record<K, Array<T>> */ ({});
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    const key = keyFinder(val);
    if (!(key in result)) {
      result[key] = [val];
    } else {
      result[key].push(val);
    }
  }
  return result;
}

/**
 * @param {Parameters<typeof entityPermissions>[1]} entity
 * @param {{
 *   introspection: import("pg-introspection").Introspection,
 *   role: import("pg-introspection").PgRoles,
 * }}
 */
function getPermissions(entity, { introspection, role }) {
  const perms = entityPermissions(introspection, entity, role, true);
  switch (entity._type) {
    case "PgAttribute": {
      const table = entity.getClass();
      const attributePermissions = entityPermissions(
        introspection,
        entity,
        role,
        true,
      );
      const tablePermissions = entityPermissions(
        introspection,
        table,
        role,
        true,
      );
      const canSelect =
        attributePermissions.select || Boolean(tablePermissions.select);
      const canInsert =
        attributePermissions.insert || Boolean(tablePermissions.insert);
      const canUpdate =
        attributePermissions.update || Boolean(tablePermissions.update);
      return { canSelect, canInsert, canUpdate };
    }
    case "PgClass": {
      const perms = entityPermissions(introspection, entity, role, true);
      let canSelect = perms.select ?? false;
      let canInsert = perms.insert ?? false;
      let canUpdate = perms.update ?? false;
      if (!canInsert || !canUpdate || !canSelect) {
        const canDelete = perms.delete ?? false;
        const attributePermissions = entity
          .getAttributes()
          .filter((att) => att.attnum > 0)
          .map((att) => entityPermissions(introspection, att, role, true));
        for (const attributePermission of attributePermissions) {
          canSelect = canSelect || Boolean(attributePermission.select);
          canInsert = canInsert || Boolean(attributePermission.insert);
          canUpdate = canUpdate || Boolean(attributePermission.update);
        }
        return { canSelect, canInsert, canUpdate, canDelete };
      }
    }
    case "PgProc": {
      const { execute } = entityPermissions(introspection, entity, role, true);
      return { canExecute: execute };
    }
    default:
      throw new Error(`unknown entity type "${entity._type}"`);
  }
}
/** @typedef {ReturnType<typeof getPermissions>} Permissions */

/** @typedef {{
  name: string;
  operation: "select" | "insert" | "update" | "delete"
  params: Array<[string, { default?: any; type: string; Pick?: Array<string> }]>;
  where?: Array<[string, string, string]>;
  join?: Array<string>;
  returnType?: string;
  returnsMany?: boolean;
  schemaName: string;
  tableName: string;
}} QueryData */

/** @typedef {{ typeImport?: boolean, identifier: string, default?: boolean, path: string}} ImportSpec */

/** @typedef {{
  imports?: Array<ImportSpec>;
  content: import("ast-types").namedTypes.BlockStatement;
  exports: Array<{ identifier: string; kind: "zod" | "type" }>;
  path: string;
}} Output */

/** @typedef {(info: {
  database: { schemas: Record<string, DbSchema> };
  results: Array<Output> | null;
  builders: import("ast-types").builders
  config: Config;
}) => Array<Output>} Plugin */

/** @typedef {{
  permissions: Permissions;
  returnType: string | undefined;
  arguments: Array<[string, { type: string; hasDefault?: boolean }]>;
}} DbProcedure */
async function main() {
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
          await client.query("select set_config('role', $1, false)", [
            config.role,
          ]);
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
        const result = await sql.begin(async (sql) => {
          if (config.role) {
            await sql`select set_config('role', ${config.role}, false)`;
          }
          const [result] = await sql.unsafe(query);
          sql.unsafe("rollback");
          return result.introspection;
        });
        sql.end();
        return result;
      }
      default:
        console.error(`invalid adapter in config: ${config.adapter}`);
        process.exit(1);
    }
  })();

  const introspection = processIntrospection(
    parseIntrospectionResults(introspectionResult, true),
  );

  const { builders } = recast.types;

  if (!("plugins" in config)) {
    console.error("no plugins defined, nothing to do");
    return process.exit(0);
  }

  /** @type {null | Array<Output>} */
  const output = config.plugins.reduce((results, fn) => {
    const output = fn({ database: introspection, results, builders, config });
    if (!(output instanceof Array))
      throw new Error("plugins must return an array");
    return results ? results.concat(output) : output;
  }, /** @type {null | Array<Output>} */ (null));

  if (!output) {
    console.error("no output from plugins");
    return process.exit(0);
  }

  Object.entries(groupBy(output, (o) => o.path)).forEach(
    async ([strPath, files]) => {
      const parsedFile = path.parse(
        path.join(config.outputDir ?? "./", strPath),
      );
      const filepath = parsedFile.dir;
      const newPath = path.join(parsedFile.dir, parsedFile.base);
      const { code } = recast.print(
        builders.program([
          ...parseDependencies(files.flatMap((f) => f.imports ?? [])),
          ...files.flatMap((f) => f.content),
        ]),
        { tabWidth: 2 },
      );

      await fs.mkdir(filepath, { recursive: true });
      await fs.writeFile(newPath, code, "utf8");
      console.log('wrote file "%s"', newPath);
    },
  );
}
main();

/** @param {import("pg-introspection").PgType} type */
function getTypeName(type) {
  return `${type.getNamespace()?.nspname}.${type.typname}`;
}

/**
 * @param {{ getDescription(): string | undefined }} entity
 */
function getDescription(entity) {
  return entity.getDescription();
}

/**
 * @param {import("pg-introspection").Introspection} introspection
 */
function processIntrospection(introspection) {
  const role = introspection.getCurrentUser();
  if (!role) throw new Error("who am i???");
  return {
    name: introspection.database.datname,
    schemas: Object.fromEntries(
      introspection.namespaces.map((schema) => [
        schema.nspname,
        processSchema(schema, { introspection, role }),
      ]),
    ),
  };
}

/** @typedef {{
  name: string;
  views: Record<string, DbView>;
  tables: Record<string, DbTable>;
  procedures: Record<string, DbProcedure>;
}} DbSchema */

/**
 * @param {import("pg-introspection").PgNamespace} schema
 * @param {{
 *   introspection: import("pg-introspection").Introspection;
 *   role: import("pg-introspection").PgRoles,
 * }}
 * @returns {DbSchema}
 */
function processSchema(schema, { introspection, role }) {
  return {
    name: schema.nspname,
    views: processViews(schema.oid, { introspection, role }),
    tables: processTables(schema.oid, { introspection, role }),
    procedures: processProcedures(schema.oid, { introspection, role }),
    // permissions: getPermissions(schema, { introspection, role }),
  };
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
 *   introspection: import("pg-introspection").Introspection,
 *   role: import("pg-introspection").PgRoles,
 * }}
 * @returns {Record<string, DbView>}
 */
function processViews(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.classes
      .filter((cls) => cls.relnamespace === schemaId && cls.relkind === "v")
      .map((view) => [
        view.relname,
        {
          name: view.relname,
          // Add other attributes specific to views
          columns: processColumns(view.oid, { introspection, role }),
          constraints: processReferences(view.oid, { introspection }),
          description: getDescription(view),
          permissions: getPermissions(view, { introspection, role }),
        },
      ]),
  );
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
 *  introspection: import("pg-introspection").Introspection,
 *  role: import("pg-introspection").PgRoles,
 * }}
 * @returns {Record<string, DbTable>}
 */
function processTables(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.classes
      .filter((cls) => cls.relnamespace === schemaId && cls.relkind === "r")
      .map((table) => {
        const references = processReferences(table.oid, { introspection });
        return [
          table.relname,
          {
            name: table.relname,
            columns: processColumns(table.oid, { introspection, role }),
            indexes: processIndices(table.oid, { introspection }),
            references,
            permissions: getPermissions(table, { introspection, role }),
            description: getDescription(table),
          },
        ];
      }),
  );
}

/** @typedef {{
  name: string;
  identity: string | null;
  type: string;
  nullable: boolean;
  generated: string | boolean;
  dimensionality: number | null;
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
      .filter((attr) => attr.attrelid === tableId)
      .map((column) => {
        const type = column.getType();
        if (!type)
          throw new Error(`couldn't find type for column ${column.attname}`);
        return [
          column.attname,
          {
            name: column.attname,
            identity: column.attidentity,
            type: getTypeName(type),
            nullable: !column.attnotnull,
            generated: column.attgenerated ? "STORED" : false,
            dimensionality: column.attndims,
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
  option: readonly Array<number> | null;
}} DbIndex */

/**
 * @param {string} tableId
 * @param {{
 *  introspection: import("pg-introspection").Introspection,
 * }}
 * @returns {Record<string, DbIndex>}
 */
function processIndices(tableId, { introspection }) {
  return Object.fromEntries(
    introspection.indexes
      .filter((index) => index.indrelid === tableId)
      .map((index) => {
        const idx = index.getIndexClass();
        if (!idx)
          throw new Error(
            `failed to find index class for index ${index.indrelid}`,
          );
        const keys = index.getKeys();
        if (!keys)
          throw new Error(`failed to find keys for index ${idx.relname}`);
        const colnames = keys.filter(Boolean).map((a) => a.attname);
        return [
          idx.relname,
          {
            name: idx.relname,
            isUnique: index.indisunique,
            isPrimary: index.indisprimary,
            option: index.indoption,
            colnames,
          },
        ];
      }),
  );
}

/** @typedef {{
  refPath: {
    schemaName: string;
    tableName: string;
    columnName: string;
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
      .filter(
        (constraint) =>
          constraint.conrelid === tableId && constraint.contype === "f",
      )
      .map((constraint) => {
        const fkeyAttr = constraint.getForeignAttributes();
        if (!fkeyAttr) throw new Error();
        const fkeyClass = constraint.getForeignClass();
        if (!fkeyClass) throw new Error();
        const fkeyNsp = fkeyClass?.getNamespace();
        if (!fkeyNsp) throw new Error();
        const refPath = {
          schemaName: fkeyNsp?.nspname,
          tableName: fkeyClass?.relname,
          columnName: fkeyAttr?.[0].attname,
        };
        return [
          constraint.conname,
          {
            refPath,
            // original: constraint,
          },
        ];
      }),
  );
}

/**
 * @param {string} schemaId
 * @param {{
 *   introspection: import("pg-introspection").Introspection,
 *   role: import("pg-introspection").PgRoles,
 * }}
 * @returns {Record<string, DbProcedure>}
 */
function processProcedures(schemaId, { introspection, role }) {
  return Object.fromEntries(
    introspection.procs
      .filter((proc) => proc.pronamespace === schemaId)
      .map((proc) => {
        const type = proc.getReturnType();
        if (!type)
          throw new Error(`couldn't find type for proc ${proc.proname}`);
        return [
          proc.proname,
          {
            permissions: getPermissions(proc, { introspection, role }),
            returnType: getTypeName(type),
            // TODO: inflection?
            arguments: !proc.proargnames
              ? []
              : proc.getArguments().map((a, i) => {
                  return [
                    proc.proargnames?.[i],
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

/** @type {(opts?: {
  schemas?: Array<string>
  path?: string | ((o: { schema: string, table: string }) => string),
}) => Plugin} pluginOpts */
export const makeZodSchemasPlugin =
  (pluginOpts) =>
  ({ database, config, builders: b }) => {
    return Object.values(database.schemas)
      .filter((s) => pluginOpts?.schemas?.includes(s.name) ?? true)
      .flatMap((schema) =>
        Object.values(schema.tables).map((table) => {
          const zodschema = [
            b.exportNamedDeclaration(
              b.variableDeclaration("const", [
                b.variableDeclarator(
                  b.identifier(PascalCase(singularize(table.name))),
                  b.callExpression(
                    b.memberExpression(
                      b.callExpression(
                        b.memberExpression(
                          b.identifier("z"),
                          b.identifier("object"),
                        ),
                        [
                          b.objectExpression(
                            Object.values(table.columns).map((c) => {
                              const value = b.callExpression(
                                b.memberExpression(
                                  b.identifier("z"),
                                  b.identifier(
                                    getTypeNameFromPgType(
                                      c.type,
                                      config,
                                    ).toLowerCase(),
                                  ),
                                ),
                                [],
                              );
                              return b.objectProperty.from({
                                key: b.literal(config.inflections.columnNames(c.name)),
                                value: c.nullable
                                  ? b.callExpression(
                                      b.memberExpression(
                                        value,
                                        b.identifier("optional"),
                                      ),
                                      [],
                                    )
                                  : value,
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
            ),
            // export type Post = z.infer<typeof Post>
            b.exportNamedDeclaration(
              b.tsTypeAliasDeclaration.from({
                id: b.identifier(
                  config.inflections.tableNames(singularize(table.name)),
                ),
                typeAnnotation: b.tsExpressionWithTypeArguments(
                  b.tsQualifiedName(b.identifier("z"), b.identifier("infer")),
                  b.tsTypeParameterInstantiation([
                    b.tsTypeQuery(
                      b.identifier(
                        config.inflections.tableNames(singularize(table.name)),
                      ),
                    ),
                  ]),
                ),
              }),
            ),
          ];

          /** @type {Output} */
          return {
            path: makePathFromConfig(pluginOpts, {
              tableName: PascalCase(table.name),
              schemaName: schema.name,
            }),
            content: zodschema,
            imports: [{ identifier: "z", path: "zod" }],
            exports: [
              { identifier, kind: "zod" },
              { identifier, kind: "type" },
            ],
          };
        }),
      );
  };

/** @type {(opts?: {
  schemas?: Array<string>
  path?: string | ((o: { schema: string, table: string }) => string),
}) => Plugin} pluginOpts */
export const makeTypesPlugin =
  (pluginOpts) =>
  ({ database, config, builders: b }) => {
    return Object.values(database.schemas)
      .filter((s) => pluginOpts?.schemas?.includes(s.name) ?? true)
      .flatMap((schema) =>
        Object.values(schema.tables).map((table) => {
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
              id: b.identifier(config.inflections.tableNames(table.name)),
              typeAnnotation: b.tsTypeLiteral(
                Object.values(table.columns).map((column) => {
                  const type = getASTTypeFromTypeName(
                    getTypeNameFromPgType(column.type, config),
                  );
                  return b.tsPropertySignature.from({
                    comments: column.description
                      ? [b.commentBlock(`* ${column.description} `)]
                      : null,
                    key: b.identifier(
                      config.inflections.columnNames(column.name),
                    ),
                    typeAnnotation: b.tsTypeAnnotation(
                      column.nullable
                        ? b.tsUnionType([type, b.tsNullKeyword()])
                        : type,
                    ),
                  });
                }),
              ),
            }),
          });
          return {
            path: makePathFromConfig(pluginOpts, {
              tableName: PascalCase(table.name),
              schemaName: schema.name,
            }),
            content: typeAlias,
            exports: [
              {
                identifier: config.inflections.tableNames(table.name),
                kind: "type",
              },
            ],
          };
        }),
      );
  };

// TODO: typescript optional? jsdoc setting?
/** @type {(opts: {
  schemas: Array<string>,
  path?: string | ((o: { schema: string, table: string }) => string),
  typescript?
}) => Plugin} pluginOpts */
export const makeQueriesPlugin =
  (pluginOpts) =>
  ({ database, builders, config, results }) => {
    /** @type {Array<Array<QueryData>>} */
    const queries = Object.values(database.schemas)
      .filter((schema) => pluginOpts.schemas.includes(schema.name))
      .flatMap((schema) =>
        Object.values(schema.tables).map((table) =>
          Object.values(table.indexes).flatMap((index) => {
            if (index.colnames.length > 1) {
              debug(
                "queries plugin",
                `ignoring multi-column index ${index.name}`,
              );
              return [];
            }
            const updateableColumns = Object.values(table.columns).filter(
              (c) => !(c.identity || c.generated),
            );
            const columns = index.colnames.map((name) => table.columns[name]);
            const column = columns[0];
            switch (true) {
              case index.isPrimary:
                /** @type {Array<QueryData>} */
                return [
                  {
                    name: camelCase(`by_${column.name}`),
                    operation: "select",
                    where: [[column.name, getOperatorFromColumn(column), "?"]],
                    params: [
                      [
                        config.inflections.columnNames(column.name),
                        { type: getTypeNameFromPgType(column.type, config) },
                      ],
                    ],
                    returnType: config.inflections.tableNames(table.name),
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                  {
                    name: "create",
                    operation: "insert",
                    params: [
                      [
                        column.name,
                        { type: getTypeNameFromPgType(column.type, config) },
                      ],
                      [
                        "patch",
                        {
                          type: config.inflections.tableNames(table.name),
                          Pick: updateableColumns
                            .filter((c) => c.permissions.canInsert)
                            .map((c) => config.inflections.columnNames(c.name)),
                        },
                      ],
                    ],
                    returnType: config.inflections.tableNames(table.name),
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                  {
                    name: "update",
                    operation: "update",
                    where: [[column.name, getOperatorFromColumn(column), "?"]],
                    params: [
                      [
                        column.name,
                        { type: getTypeNameFromPgType(column.type, config) },
                      ],
                      [
                        "patch",
                        {
                          type: config.inflections.tableNames(table.name),
                          Pick: updateableColumns
                            .filter((c) => c.permissions.canUpdate)
                            .map((c) => config.inflections.columnNames(c.name)),
                        },
                      ],
                    ],
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                  {
                    name: "delete",
                    operation: "delete",
                    where: [[column.name, getOperatorFromColumn(column), "?"]],
                    params: [
                      [
                        column.name,
                        { type: getTypeNameFromPgType(column.type, config) },
                      ],
                    ],
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                ];
              case column.type === "pg_catalog.tsvector":
                // return [];
                return {
                  name: camelCase(`search_${table.name}`),
                  operation: 'select',
                  join: 'lateral websearch_to_tsquery(?) as q',
                  where: [[column.name, '@@', 'q']],
                  params: [
                    [column.name, { type: getTypeNameFromPgType(column.type, config) }],
                    ["limit", { default: 100, type: "number" }],
                    ["offset", { default: 0, type: "number" }],
                  ],
                  returnType: config.inflections.tableNames(table.name),
                  returnsMany: true,
                  schemaName: schema.name,
                  tableName: table.name,
                };
              case column.type === "pg_catalog.timestamptz":
                return {
                  name: camelCase(`by_${column.name}`),
                  operation: "select",
                  params: [
                    [
                      column.name,
                      { type: getTypeNameFromPgType(column.type, config) },
                    ],
                    ["limit", { default: 100, type: "number" }],
                    ["offset", { default: 0, type: "number" }],
                  ],
                  orderBy: [
                    column.name,
                    index.option && index.option[0] == 3 ? "desc" : "asc",
                  ],
                  returnType: config.inflections.tableNames(table.name),
                  returnsMany: !index.isPrimary,
                  schemaName: schema.name,
                  tableName: table.name,
                };
              default:
                return {
                  name: camelCase(`by_${column.name}`),
                  operation: "select",
                  where: [
                    [
                      config.inflections.columnNames(column.name),
                      getOperatorFromColumn(column),
                      "?",
                    ],
                  ],
                  params: [
                    [
                      config.inflections.columnNames(column.name),
                      { type: getTypeNameFromPgType(column.type, config) },
                    ],
                    ["limit", { default: 100, type: "number" }],
                    ["offset", { default: 0, type: "number" }],
                  ],
                  returnType: config.inflections.tableNames(table.name),
                  returnsMany: !index.isPrimary,
                  schemaName: schema.name,
                  tableName: table.name,
                };
            }
          }),
        ),
      );
    return queries.flatMap((queryData) => {
      const { tableName, schemaName } = queryData[0];
      const typeRef = findExports({ results, identifier: config.inflections.tableNames(tableName) });
      /** @type {Output} */
      return {
        path: makePathFromConfig(pluginOpts, {
          tableName: PascalCase(tableName),
          schemaName,
        }),
        imports: [
          typeRef,
          config.adapter === "pg"
            ? { identifier: "pg", typeImport: true, default: true, path: "pg" }
            : config.adapter === "postgres"
              ? {
                  identifier: "Sql",
                  typeImport: true,
                  default: false,
                  path: "postgres",
                }
              : {},
        ],
        content: queryDataToObjectMethods(
          { queryData, tableName },
          { config, builders },
        ),
      };
    });
  };

/**
 * @param {{ path?: string | ((o: { schema: string, table: string }) => string) }}
 * @param {{ schemaName: string, tableName: string }}
 */
function makePathFromConfig(
  { path },
  { schemaName: schema, tableName: table },
) {
  return typeof path === "function"
    ? path({ schema, table })
    : typeof path === "string"
      ? path
      : `../${table}.ts}`;
}

/** @param {QueryData} queryData */
function queryBuilder(queryData) {
  const target = `${queryData.schemaName}.${queryData.tableName}` 
  return (() => {
    switch (queryData.operation) {
      case "select": {
        const limit = queryData.params.find(([name]) => name === "limit");
        const offset = queryData.params.find(([name]) => name === "offset");
        return [
          "select * from",
          target,
          queryData.join,
          queryData.where &&
            `where ${queryData.where.map((p) => p.join(" ")).join(" and ")}`,
          limit && 'limit ?',
          offset && 'offset ?',
        ];
      }
      case "insert": {
        const columns = queryData.params.map(([name]) => name).join(", ");
        const values = queryData.params.map(() => "?").join(", ");
        return [
          `insert into ${target}`,
          `(${columns}) values (${values})`,
          "returning *",
        ];
      }
      case "update": {
        const values = queryData.params
          .map(([name]) => `${name} = ?`)
          .join(", ");
        return [
          `update ${target}`,
          `set ${values}`,
          `where ${queryData.where?.map((p) => p.join(" ")).join(" and ")}`,
        ];
      }
      case "delete": {
        return [
          `delete from ${target}`,
          queryData.where &&
            `where ${queryData.where.map((p) => p.join(" ")).join(" and ")}`,
        ];
      }
      default:
        throw new Error(`unknown operation "${queryData.operation}"`);
    }
  })()
    .filter(Boolean)
    .join(" ");
}

// TODO: alternative styles?
/**
 * @param {{
 *   queryData: Array<QueryData>;
 *   tableName: string;
 * }} _
 * @param {{
 *   builders: import("ast-types").builders;
 *   config: Config
 * }} _
 */
function queryDataToObjectMethods(
  { queryData, tableName },
  { config, builders: b },
) {
  return b.exportNamedDeclaration(
    b.variableDeclaration("const", [
      b.variableDeclarator(
        b.identifier(PascalCase(tableName)),
        b.objectExpression.from({
          properties: queryData.map((queryData) => {
            return b.objectMethod.from({
              kind: "method",
              async: true,
              key: b.identifier(queryData.name),
              params: [
                b.objectPattern.from({
                  properties: queryData.params.map(
                    ([name, { default: defaultValue }]) =>
                      b.property.from({
                        kind: "init",
                        key: b.identifier(name),
                        value:
                          defaultValue != null && defaultValue !== ""
                            ? b.assignmentPattern.from({
                                left: b.identifier(name),
                                right: b.literal(defaultValue),
                              })
                            : b.identifier(name),
                        shorthand: true,
                      }),
                  ),
                  typeAnnotation: b.tsTypeAnnotation(
                    b.tsTypeLiteral(
                      queryData.params.map(
                        ([name, { default: hasDefault, type, Pick }]) => {
                          return b.tsPropertySignature.from({
                            key: b.identifier(name),
                            optional: hasDefault != null,
                            typeAnnotation: b.tsTypeAnnotation(
                              Pick
                                ? b.tsTypeReference(
                                    b.identifier("Partial"),
                                    b.tsTypeParameterInstantiation([
                                      b.tsTypeReference(
                                        b.identifier("Pick"),
                                        b.tsTypeParameterInstantiation([
                                          b.tsTypeReference(
                                            b.identifier(singularize(type)),
                                          ),
                                          b.tsUnionType(
                                            Pick.map((key) =>
                                              b.tsLiteralType(
                                                b.stringLiteral(key),
                                              ),
                                            ),
                                          ),
                                        ]),
                                      ),
                                    ]),
                                  )
                                : typeof type === "string"
                                  ? getASTTypeFromTypeName(type)
                                  : type,
                            ),
                          });
                        },
                      ),
                    ),
                  ),
                }),
                config.adapter === "pg"
                  ? b.identifier.from({
                      name: "pool",
                      typeAnnotation: b.tsTypeAnnotation(
                        b.tsUnionType([
                          b.tsTypeReference(b.identifier("pg.Client")),
                          b.tsTypeReference(b.identifier("pg.Pool")),
                        ]),
                      ),
                    })
                  : b.identifier.from({
                      name: "sql",
                      typeAnnotation: b.tsTypeAnnotation(
                        b.tsTypeReference(b.identifier("Sql")),
                      ),
                    }),
              ],
              body: {
                pg() {
                  const queryStr = queryBuilder(queryData)
                    .split('?')
                .reduce((acc, part, i) => i === 0 ? `${acc}${part}` : `${acc}$${i}` + part, '');
                  const queryExpression = b.awaitExpression(
                    b.callExpression.from({
                      callee: b.memberExpression(
                        b.identifier("pool"),
                        b.identifier("query"),
                      ),
                      typeArguments: queryData.returnType
                        ? b.typeParameterInstantiation([
                            b.typeParameter(queryData.returnType),
                          ])
                        : null,
                      arguments: [
                        b.stringLiteral(queryStr),
                        b.arrayExpression(
                          queryData.params.map(([argName]) =>
                            b.identifier(argName),
                          ),
                        ),
                      ],
                    }),
                  );
                  if (!queryData.returnType) {
                    return b.blockStatement([
                      b.returnStatement(queryExpression),
                    ]);
                  }

                  return b.blockStatement([
                    b.variableDeclaration("const", [
                      b.variableDeclarator(
                        b.identifier("result"),
                        queryExpression,
                      ),
                    ]),
                    b.returnStatement(
                      queryData.returnsMany
                        ? b.memberExpression(
                            b.identifier("result"),
                            b.identifier("rows"),
                          )
                        : b.memberExpression(
                            b.memberExpression(
                              b.identifier("result"),
                              b.identifier("rows"),
                            ),
                            b.literal(0),
                          ),
                    ),
                  ]);
                },
                postgres() {
                  let query = queryBuilder(queryData, { config })
                    .split("?")
                    .flatMap((part, i) => i === 0 ? b.templateElement({ raw: part, cooked: part }, false) : b.templateElement({ raw: part, cooked: part }, true), '');
                  const queryExpression = b.awaitExpression(
                    b.taggedTemplateExpression.from({
                      tag: b.tsInstantiationExpression.from({
                        expression: b.identifier("sql"),
                        typeParameters: !queryData.returnType
                          ? null
                          : b.tsTypeParameterInstantiation([
                              b.tsTypeReference(
                                b.identifier("Array"),
                                b.tsTypeParameterInstantiation([
                                  b.tsTypeReference(
                                    b.identifier(queryData.returnType),
                                  ),
                                ]),
                              ),
                            ]),
                      }),
                      quasi: b.templateLiteral(query, queryData.params.map(([name]) => b. identifier(name))),
                    }),
                  );
                  if (!queryData.returnType) {
                    return b.blockStatement([
                      b.returnStatement(queryExpression),
                    ]);
                  }

                  return b.blockStatement([
                    b.variableDeclaration("const", [
                      b.variableDeclarator(
                        b.identifier("result"),
                        queryExpression,
                      ),
                    ]),
                    b.returnStatement(
                      queryData.returnsMany
                        ? b.identifier("result")
                        : b.memberExpression(
                            b.identifier("result"),
                            b.literal(0),
                          ),
                    ),
                  ]);
                },
              }[config.adapter](),
            });
          }),
        }),
      ),
    ]),
  );
}

// TODO: not handled: import <default>, { type <named> } from '<path>'
/** @param {Array<ImportSpec>} deps */
function parseDependencies(deps) {
  const b = recast.types.builders;
  return Object.values(groupBy(deps, (d) => d.path)).map(
    (dep) => {
      const ids = groupBy(dep, d => d.identifier)
      if (dep.length > 1 && Object.keys(ids).length > 1) {
        const allTypes = dep.every((d) => d.typeImport)
        return b.importDeclaration.from({
          importKind: allTypes ? "type" : "value",
          specifiers: dep.map(d => b.importSpecifier.from({
            imported: b.identifier(d.identifier),
          })),
          source: b.literal(dep[0].path),
        });
      }
      const [d] = dep
      return b.importDeclaration.from({
        importKind: d.typeImport ? "type" : "value",
        specifiers: d.default
          ? [
              b.importDefaultSpecifier.from({
                local: b.identifier(d.identifier),
              }),
            ]
          : [b.importSpecifier(b.identifier(d.identifier))],
        source: b.literal(d.path),
      });
    },
  );
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
function getTypeNameFromPgType(pgTypeString, config) {
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
      return "unknown";
  }
}

/** @param {DbColumn} column */
function getOperatorFromColumn(column) {
  switch (true) {
    case column.type === "pg_catalog.tsvector":
      return "@@";
    case Boolean(column.dimensionality):
      return "@>";
    default:
      return "=";
  }
}

/** @param {{ results: Output[], identifier: string }} _ */
function findExports({ results, identifier }) {
  let typeRef;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const e = r.exports?.find((e) => e.kind === 'type');
    if (e && e.identifier === identifier) {
      /** @type {ImportSpec} */
      typeRef = { identifier: e.identifier, path: r.path, typeImport: true };
      break;
    }
  }
  if (!typeRef) throw new Error(`could not type export for ${identifier}`);
  return typeRef;
}
