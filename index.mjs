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

const debug = _debug("pg-codeforge");

/** @param {string} str */
const camelCase = (str) => camelize(str, true);

/** @param {string} str */
const PascalCase = (str) => camelize(str, false);

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
 * @param {Parameters<typeof entityPermissions>[1]} entity
 * @param {{
 *   introspection: import("pg-introspection").Introspection,
 *   role: import("pg-introspection").PgRoles,
 *   parent?: Array<Parameters<typeof entityPermissions>[1]>
 * }}
 */
function getPermissions(entity, { introspection, parent, role }) {
  const perms = entityPermissions(introspection, entity, role, true);
  const canSelect = perms.select ?? false;
  const canInsert = perms.insert ?? false;
  const canUpdate = perms.update ?? false;
  const canDelete = perms.delete ?? false;
  // if (!canInsert || !canUpdate || !canSelect) {
  //   const attributePermissions = entity
  //   .filter((att) => att.attnum > 0)
  //   .map((att) =>
  //     entityPermissions(introspection, att, role, true),
  //   );
  //   for (const attributePermission of attributePermissions) {
  //     canSelect = canSelect || attributePermission.select;
  //     canInsert = canInsert || attributePermission.insert;
  //     canUpdate = canUpdate || attributePermission.update;
  //   }
  // }
  return { canSelect, canInsert, canUpdate, canDelete };
}
/** @typedef {ReturnType<typeof getPermissions>} Permissions */

/** @typedef {{
  name: string;
  operation: "select" | "insert" | "update" | "delete"
  params: Array<[string, { default?: any; type: string; Pick?: string[] }]>;
  where?: Array<[string, string, string]>;
  returnType?: string;
  returnsMany?: boolean;
  schemaName: string;
  tableName: string;
}} QueryData */

/** @typedef {{
  dependencies?: string[];
  content: import("ast-types").builders
  path: string;
}} Output */

/** @typedef {(info: {
  database: Introspection;
  results: Output[] | null;
  //statement kinds
  builders: import("ast-types").builders
  config: Config;
}) => Output[]} Plugin */

/** @typedef {{
  connectionString: string;
  adapter: "pg" | "postgres";
} & Partial<{
  role: string;
  plugins: Plugin[];
}>} Config */

/** @typedef {{
  permissions: Permissions;
  returnType: string | undefined;
  arguments: Array<[string, { type: string; hasDefault?: boolean }]>;
}} DbProcedure */
async function main() {
  let configSearch = await cosmiconfig("pgcodeforge").search();
  if (!configSearch) {
    console.error("a codeforge config file is required");
    process.exit(1);
  }
  const config = configSearch.config;

  const introspectionResult = await (async () => {
    if (!config.connectionString) {
      console.error("no connectionString provided");
      process.exit(1);
    }
    const query = makeIntrospectionQuery();
    switch (config.adapter) {
      case "pg": {
        const pg = await import("pg");
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

  /** @type {Output[]} */
  const output = config.plugins?.reduce((results, fn) => {
    const output = fn({ database: introspection, results, builders, config });
    if (!(output instanceof Array))
      throw new Error("plugins must return an array");
    return results ? results.concat(output) : output;
  }, /** @type {null | Output[]} */ (null));

  if (!output) {
    console.error("no output from plugins");
    return process.exit(0);
  }

  Object.entries(Object.groupBy(output, (o) => o.path)).forEach(
    async ([strPath, files]) => {
      const parsedFile = path.parse(
        path.join(config.outputDir ?? "./", strPath),
      );
      const filepath = parsedFile.dir;
      const newPath = path.join(parsedFile.dir, parsedFile.base);

      const { code } = recast.print(
        builders.program(files.map((f) => f.content)),
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

/** @typedef {{
  database: string;
  schemas: { [k: string]: DbSchema };
}} Introspection */

/**
 * @param {import("pg-introspection").Introspection} introspection
 */
function processIntrospection(introspection) {
  const role = introspection.getCurrentUser();
  if (!role) throw new Error("who am i???");
  return {
    database: introspection.database.datname,
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
  permissions: Permissions;
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
    permissions: getPermissions(schema, { introspection, role }),
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
            permissions: entityPermissions(introspection, table, role, true),
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
            permissions: entityPermissions(introspection, column, role, true),
          },
        ];
      }),
  );
}

/** @typedef {{
  name: string;
  colnames: string[];
  isUnique: boolean | null;
  isPrimary: boolean | null;
  option: readonly number[] | null;
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

/** @type {(opts?: { schemas?: string[] }) => Plugin} pluginOptions */
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
                    trailing: true,
                    leading: true,
                    value: `* ${table.description} `,
                  }),
                ]
              : null,
            declaration: b.tsTypeAliasDeclaration.from({
              id: b.identifier(PascalCase(singularize(table.name))),
              typeAnnotation: b.tsTypeLiteral(
                Object.values(table.columns).map((column) => {
                  const type = typeNameFromPgType(column.type);
                  return b.tsPropertySignature.from({
                    comments: column.description
                      ? [
                          b.commentBlock.from({
                            leading: true,
                            value: `* ${column.description} `,
                          }),
                        ]
                      : null,
                    key: b.identifier(column.name),
                    typeAnnotation: b.tsTypeAnnotation(
                      column.nullable
                        ? b.tsUnionType([getASTTypeFromTypeName(type), b.tsNullKeyword()])
                        : getASTTypeFromTypeName(type),
                    ),
                  });
                }),
              ),
            }),
          });
          return {
            path: `./${schema.name}/${PascalCase(table.name)}.ts`,
            content: typeAlias,
          };
        }),
      );
  };

/** @type {(opts: { schemas: string[] }) => Plugin} pluginOptions */
export const createQueriesPlugin =
  (pluginOptions) =>
  ({ database, builders, config }) => {
    /** @type {QueryData[][]} */
    const queries = Object.values(database.schemas)
      .filter((schema) => pluginOptions.schemas.includes(schema.name))
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
              // TODO: RLS
              (c) => !(c.identity || c.generated),
            );
            const columns = index.colnames.map((name) => table.columns[name]);
            const column = columns[0];
            switch (true) {
              case index.isPrimary:
                return [
                  {
                    name: camelCase(`by_${column.name}`),
                    operation: "select",
                    where: [[column.name, getOperatorFromColumn(column), "?"]],
                    params: [
                      [column.name, { type: typeNameFromPgType(column.type) }],
                    ],
                    returnType: PascalCase(table.name),
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                  {
                    name: "create",
                    operation: "insert",
                    params: [
                      [column.name, { type: typeNameFromPgType(column.type) }],
                      [
                        "patch",
                        {
                          type: PascalCase(table.name),
                          Pick: updateableColumns.map((c) => c.name),
                        },
                      ],
                    ],
                    returnType: PascalCase(table.name),
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                  {
                    name: "update",
                    operation: "update",
                    where: [[column.name, getOperatorFromColumn(column), "?"]],
                    params: [
                      [column.name, { type: typeNameFromPgType(column.type) }],
                      [
                        "patch",
                        {
                          type: PascalCase(table.name),
                          Pick: updateableColumns.map((c) => c.name),
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
                      [column.name, { type: typeNameFromPgType(column.type) }],
                    ],
                    returnsMany: false,
                    schemaName: schema.name,
                    tableName: table.name,
                  },
                ];
              case column.type === "pg_catalog.tsvector":
                return [];
              // return {
              //   name: camelCase(`search_${table.name}`),
              //   query: `select * from ${fullTableName}, lateral websearch_to_tsquery($1) as q where ${column.name} @@ q`,
              //   params: [
              //     [column.name, { type: typeNameFromPgType(column.type) }],
              //     ["limit", { default: 100, type: "number" }],
              //     ["offset", { default: 0, type: "number" }],
              //   ],
              //   returnType: PascalCase(table.name),
              //   returnsMany: true,
              //   schemaName: schema.name,
              //   tableName: table.name,
              // };
              case column.type === "pg_catalog.timestamptz":
                return {
                  name: camelCase(`by_${column.name}`),
                  operation: "select",
                  params: [
                    [column.name, { type: typeNameFromPgType(column.type) }],
                    ["limit", { default: 100, type: "number" }],
                    ["offset", { default: 0, type: "number" }],
                  ],
                  orderBy: [
                    column.name,
                    index.option && index.option[0] == 3 ? "desc" : "asc",
                  ],
                  returnType: PascalCase(table.name),
                  returnsMany: !index.isPrimary,
                  schemaName: schema.name,
                  tableName: table.name,
                };
              default:
                return {
                  name: camelCase(`by_${column.name}`),
                  operation: "select",
                  where: [[column.name, getOperatorFromColumn(column), "$1"]],
                  params: [
                    [column.name, { type: typeNameFromPgType(column.type) }],
                    ["limit", { default: 100, type: "number" }],
                    ["offset", { default: 0, type: "number" }],
                  ],
                  returnType: PascalCase(table.name),
                  returnsMany: !index.isPrimary,
                  schemaName: schema.name,
                  tableName: table.name,
                };
            }
          }),
        ),
      );
    /** @satisifies {Output[]} */
    return queries.map((queryData) => {
      const example = queryData[0];
      return {
        path: `./${example.schemaName}/${PascalCase(example.tableName)}.ts`,
        content: buildJSFunctions(
          { queryData, tableName: example.tableName },
          { config, builders },
        ),
      };
    });
  };

/**
 * @param {QueryData} queryData
 * @param {{ config: Config }} config
 */
function queryBuilder(queryData, { config }) {
  switch (queryData.operation) {
    case "delete":
      return `delete from ${queryData.schemaName}.${queryData.tableName}${
        !queryData.where
          ? ""
          : ` where ${queryData.where.map((p) => p.join(" ")).join(" and ")}`
      }`;
    case "select":
      return `select * from ${queryData.schemaName}.${queryData.tableName}${
        !queryData.where
          ? ""
          : ` where ${queryData.where.map((p) => p.join(" ")).join(" and ")}`
      }`;
    case "insert":
      return `insert into ${queryData.schemaName}.${
        queryData.tableName
      } (${queryData.params
        .map(([name]) => name)
        .join(", ")}) values (${queryData.params
        .map((_, i) => "?")
        .join(", ")}) returning *`;
    case "update":
      return `update ${queryData.schemaName}.${
        queryData.tableName
      } set ${queryData.params
        .map(([name], i) => `${name} = $${i + 1}`)
        .join(", ")} where ${queryData.where
        ?.map((p) => p.join(" "))
        .join(" and ")}`;
    default:
      throw new Error(`unknown operation "${queryData.operation}"`);
  }
}

/**
 * @param {
 *   queryData: QueryData[];
 *   tableName: string;
 * } queryData;
 * @param {{
 *   builders: import("ast-types").builders;
 *   config: Config
 * }}
 */
function buildJSFunctions({ queryData, tableName }, { config, builders: b }) {
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
                  properties: queryData.params.map((arg) => {
                    const [name, { default: defaultValue, type }] = arg;
                    return b.property.from({
                      kind: "init",
                      key: b.identifier(name),
                      value:
                        defaultValue != null && defaultValue != ""
                          ? b.assignmentPattern.from({
                              left: b.identifier(name),
                              right: b.literal(defaultValue),
                            })
                          : b.identifier(name),
                      shorthand: true,
                    });
                  }),
                  typeAnnotation: b.tsTypeAnnotation(
                    b.tsTypeLiteral(
                      queryData.params.map(([name, { type, Pick }]) => {
                        return b.tsPropertySignature.from({
                          key: b.identifier(name),
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
                      }),
                    ),
                  ),
                }),
                config.adapter === "pg"
                  ? b.identifier("pool")
                  : b.identifier("sql"),
              ],
              returnType: b.tsTypeAnnotation(
                b.tsTypeReference(
                  b.identifier("Promise"),
                  b.tsTypeParameterInstantiation([
                    queryData.returnType
                      ? b.tsTypeReference(
                          b.identifier("Array"),
                          b.tsTypeParameterInstantiation([
                            b.tsTypeReference(
                              b.identifier(
                                PascalCase(singularize(queryData.returnType)),
                              ),
                            ),
                          ]),
                        )
                      : b.tsTypeReference(b.identifier("void")),
                  ]),
                ),
              ),
              body: {
                pg() {
                  const queryExpression = b.awaitExpression(
                    b.callExpression(
                      b.memberExpression(
                        b.identifier("pool"),
                        b.identifier("query"),
                      ),
                      [b.stringLiteral(queryBuilder(queryData, {config}))].concat(
                        !queryData.params.length
                          ? []
                          : [
                              b.arrayExpression(
                                queryData.params.map(([argName]) =>
                                  b.identifier(argName),
                                ),
                              ),
                            ],
                      ),
                    ),
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
                  let queryString = `${queryData.operation} * from ${queryData.schemaName}.${queryData.tableName}`;

                  if (queryData.where) {
                    const [fieldName, operator, placeholder] = queryData.where;
                    queryString += ` where ${fieldName} ${operator} ${placeholder}`;
                  }

                  return b.blockStatement([
                    b.returnStatement(
                      b.awaitExpression(
                        b.callExpression(b.identifier("sql.query"), []),
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

const typelist = ["number", "string", "boolean", "json", "Date"];

function parseDependencies(deps) {
  return deps.filter((d) => !typelist.includes(d));
}

function getASTTypeFromColumnType(type) {
  const b = recast.types.builders;
  switch (type) {
    case "pg_catalog.uuid":
    case "pg_catalog.text":
    case "pg_catalog.tsvector":
    case "pg_catalog.varchar":
    case "pg_catalog.json":
    case "pg_catalog.jsonb":
    case "public.citext":
      return b.tsStringKeyword();
    case "pg_catalog.bool":
      return b.tsBooleanKeyword();
    case "pg_catalog.timestamptz":
      return b.tsTypeReference(b.identifier("Date"));
    case "array":
      return b.tsArrayType(b.tsStringKeyword());
    case "pg_catalog.int4":
      return b.tsNumberKeyword();
    default:
      debug(`unknown type "${type}"`);
      return b.tsUnknownKeyword();
  }
}

/** @param {"string" | "boolean" | "number" | "Date" | "unknown"} type */
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
 * @returns {"string" | "boolean" | "number" | "Date" | "unknown"}
 */
function typeNameFromPgType(pgTypeString) {
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
