// @ts-check

const path = require("path");
const { camelize, singularize } = require("inflection");
const debug = require("debug")("pg-gen-query");
const recast = require("recast");

/** @typedef {{
  name: string;
  query: string;
  args: Array<[string, { default?: any; type: string }]>;
  returnType: string;
  returnsMany: boolean;
  schemaName: string;
  tableName: string;
  typeImports?: import('kanel').TypeImport[];
}} QueryData */

/** @param {{tableNames?: string[], adapter: 'postgres' | 'pg'}} options */
function makeQueriesHook({ tableNames, adapter }) {
  /** @type {import('kanel').PreRenderHook} */
  return function makeQueries(output, config) {
    /** @param {import('extract-pg-schema').Schema} schema* */
    function processSchema(schema) {
      return schema.tables
        .filter((t) => tableNames?.includes(t.name) ?? true)
        .flatMap((t) => processTable(t, { schema }));
    }

    /**
     * @param {import('extract-pg-schema').TableDetails} table
     * @param {{ schema: import('extract-pg-schema').Schema }} schema
     */
    function processTable(table, { schema }) {
      const fullTableName =
        schema.name === "public" ? table.name : `${schema.name}.${table.name}`;
      /** @type {Array<QueryData>} */
      const queries = [];
      /** @type {Array<QueryData>} */
      const indices = table.columns.flatMap((column) =>
        column.indices.flatMap((index) =>
          processIndex({ index, column, table, schema, fullTableName }),
        ),
      );
      indices.forEach((e) => queries.push(e));
      // const imports = new Set(typeName);
      debug(`found ${queries.length} queries for table ${fullTableName}`);
      return queries;
    }

    /** @param {{
      column: import('extract-pg-schema').TableColumn;
      index: import('extract-pg-schema').Index;
      table: import('extract-pg-schema').TableDetails;
      schema: import('extract-pg-schema').Schema;
      fullTableName: string;
    }} */
    function processIndex({ column, index, table, schema, fullTableName }) {
      debug(`found index on ${table.name}.${column.name}`);

      const r = column.references[0];
      const referencingColumn =
        r &&
        config.schemas[r.schemaName].tables
          .find((t) => t.name === r.tableName)
          ?.columns.find((c) => c.name === r.columnName);
      if (referencingColumn) {
        const newRef = [schema.name, table.name, column.name];
        if (
          "referencedBy" in referencingColumn &&
          referencingColumn.referencedBy instanceof Array
        ) {
          referencingColumn.referencedBy.push(newRef);
        } else {
          referencingColumn["referencedBy"] = [newRef];
        }
      }

      switch (true) {
        case index.isPrimary: {
          const updateableColumns = table.columns
            // TODO: use RLS to refine updateable columns
            .filter((c) => !(c.generated === "ALWAYS" || !c.isUpdatable));
          return [
            // insert query
            {
              name: camelize(`create_${singularize(table.name)}`, true),
              // FIXME: queries really should be a syntax tree
              query: `insert into ${fullTableName} (${updateableColumns
                .map((c) => c.name)
                .join(", ")}) values(${updateableColumns
                .map((c) => c.name)
                .map((_, i) => `$${i + 1}`)
                .join(", ")})`,
              args: updateableColumns.map((c) => [
                c.name,
                { type: config.typeMap[c.type] },
              ]),
              returnType: "",
              returnsMany: false,
              schemaName: schema.name,
              tableName: table.name,
            },
            // select by id
            {
              name: camelize(
                `select_${singularize(table.name)}_by_${column.name}`,
                true,
              ),
              query: `select * from ${table.name} where ${column.name} = $1`,
              args: [
                [column.name, { type: config.typeMap[column.expandedType] }],
              ],
              returnType: "",
              returnsMany: false,
              schemaName: schema.name,
              tableName: table.name,
            },
            // update query
            {
              name: camelize(`update_${singularize(table.name)}`, true),
              query: `update ${fullTableName} where ${column.name} = $1`,
              args: [
                [column.name, { type: config.typeMap[column.expandedType] }],
              ],
              returnType: "",
              returnsMany: false,
              schemaName: schema.name,
              tableName: table.name,
            },
            // delete query
            {
              name: camelize(`delete_${singularize(table.name)}`, true),
              query: `delete from ${table.name} where id = $1`,
              args: [
                [column.name, { type: config.typeMap[column.expandedType] }],
              ],
              returnType: "",
              returnsMany: false,
              schemaName: schema.name,
              tableName: table.name,
            },
          ];
        }
        case column.expandedType === "pg_catalog.tsvector":
          return [];
          return {
            name: camelize(`search_${table.name}`, true),
            query: `select * from ${fullTableName} left join lateral websearch_to_tsquery($1) q where ${column.name} @@ q`,
            args: [
              ["limit", { default: 100, type: "number" }],
              ["offset", { default: 0, type: "number" }],
            ],
            schemaName: schema.name,
            tableName,
          };
        case column.expandedType === "pg_catalog.timestamptz":
          return {
            name: camelize(`select_${table.name}_by_${column.name}`, true),
            query: `select * from ${fullTableName} order by ${column.name} limit $1 offset $2`,
            args: [
              ["limit", { default: 100, type: "number" }],
              ["offset", { default: 0, type: "number" }],
            ],
            returnType: camelize(table.name),
            returnsMany: !index.isPrimary,
            schemaName: schema.name,
            tableName: table.name,
          };

        default:
          return {
            name: camelize(`select_${table.name}_by_${column.name}`, true),
            query: `select * from ${fullTableName} where ${
              column.name
            } ${getOperatorFromColumn(column)} $1 limit $2 offset $3`,
            args: [
              [column.name, { type: config.typeMap[column.expandedType] }],
              ["limit", { default: 100, type: "number" }],
              ["offset", { default: 0, type: "number" }],
            ],
            returnType: camelize(table.name),
            returnsMany: !index.isPrimary,
            schemaName: schema.name,
            tableName: table.name,
          };
      }
    }

    /** @typedef {import('extract-pg-schema').Schema & {tables:Array<{referencedBy: [string, string, string]}>} } SchemaWithReferences */

    /**
     * @param {Record<string, import('extract-pg-schema').Schema>} schemas
    * @returns {Array<QueryData>}
     * */

    function processReferences(schemas) {
      return []
      return Object.values(schemas)
        .flatMap((s) =>
          s.tables.flatMap((t) =>
            t.columns
              .filter((c) => c.referencedBy)
              ?.flatMap((c) =>
                c.referencedBy.flatMap((r) => ({
                  query: `select * from ${t.name} join ${r[0]}.${r[1]} on ${t.name}.${c.name} = ${r[1]}.${r[2]}`,
                  // args: [[r.name, { type: config.typeMap[r.expandedType] }]],
                  schemaName: s.name,
                  tableName: t.name,
                  returnsMany: false,
                  returnType: camelize(t.name),
                })),
              ),
          ),
        )
    }

    const REPLACE_TOKEN = "REPLACE_TOKEN";
    const b = recast.types.builders;

    /** @param {QueryData} queryData */
    function buildJSFunctionString(queryData) {
      const ast = recast.parse("");

      const column = queryData.args.find((arg) => arg[1].column);

      const fn = b.functionDeclaration.from({
        id: b.identifier(queryData.name),
        async: true,
        params: [
          b.objectPattern.from({
            properties: [
              ...queryData.args.map((arg) => {
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
            ],
            typeAnnotation: b.tsTypeAnnotation(
              b.tsTypeLiteral([
                ...queryData.args.map((arg) => {
                  const [name, { type }] = arg;
                  return b.tsPropertySignature.from({
                    key: b.identifier(name),
                    typeAnnotation: b.tsTypeAnnotation(
                      getASTTypeFromColumnType(type),
                    ),
                  });
                }),
              ]),
            ),
          }),
        ],
        returnType: b.tsTypeAnnotation(
          b.tsTypeReference(
            b.identifier("Promise"),
            b.tsTypeParameterInstantiation([
              b.tsTypeReference(
                b.identifier("Array"),
                b.tsTypeParameterInstantiation([
                  b.tsTypeReference(b.identifier(queryData.tableName)),
                ]),
              ),
            ]),
          ),
        ),
        body: b.blockStatement([
          b.returnStatement(
            b.taggedTemplateExpression.from({
              quasi: b.templateLiteral.from({
                expressions: [
                  b.literal(REPLACE_TOKEN),
                  ...queryData.args
                    .filter((arg) => arg[1].column)
                    .map((arg) => b.identifier(arg[0])),
                  ...queryData.args
                    .filter((arg) => !arg[1].column)
                    .map((arg) => b.identifier(arg[0])),
                ],
                quasis: [
                  b.templateElement.from({
                    tail: false,
                    value: {
                      cooked: null,
                      raw: `select * from ${queryData.schemaName}.${queryData.tableName} `,
                    },
                  }),
                  ...(() => {
                    if (!column) return [];

                    if (column[1].type === "date") {
                      return [
                        b.templateElement.from({
                          tail: false,
                          value: {
                            cooked: null,
                            raw: ` order by ${column[0]} `,
                          },
                        }),
                      ];
                    }

                    return [
                      b.templateElement.from({
                        tail: false,
                        value: {
                          cooked: null,
                          raw: ` WHERE ${column[0]} ${getOperatorFromColumnType(
                            column[1].type,
                          )} `,
                        },
                      }),
                    ];
                  })(),
                  ...queryData.args
                    .filter((arg) => !arg[1].column)
                    .map((arg) =>
                      b.templateElement.from({
                        tail: false,
                        value: {
                          cooked: null,
                          raw: ` ${arg[0]} `,
                        },
                      }),
                    ),
                ].filter(Boolean),
              }),
              tag: b.identifier("sql"),
            }),
          ),
        ]),
      });

      ast.program.body[0] = fn;

      return recast.print(ast).code.replace(' ${"REPLACE_TOKEN"} ', " ");
    }

    function getASTTypeFromColumnType(type) {
      switch (type) {
        case "string":
        case "tsvector":
          return b.tsStringKeyword();
        case "array":
          return b.tsArrayType(b.tsStringKeyword());
        case "number":
          return b.tsNumberKeyword();
        default:
          return b.tsUnknownKeyword();
      }
    }

    const schemaQueries = Object.values(config.schemas).flatMap(processSchema);

    const referenceQueries = processReferences(config.schemas);

    schemaQueries.concat(referenceQueries).forEach((q) => {
      const newPath = path.join(config.outputPath, "queries");
      const lines = buildJSFunctionString(q).split("\n");
      /** @type {import('kanel').Declaration} */
      const d = {
        declarationType: "generic",
        typeImports: q.typeImports,
        lines,
      };
      if (!output[newPath]) output[newPath] = { declarations: [] };
      if (!output[newPath].declarations) output[newPath].declarations = [];
      output[newPath].declarations.push(d);
    });

    return output;
  };
}

/** @param {import('extract-pg-schema').TableColumn} column */
function getOperatorFromColumn(column) {
  switch (true) {
    case column.expandedType === "pg_catalog.tsvector":
      return "@@";
    case column.isArray:
      return "@>";
    default:
      return "=";
  }
}

module.exports = makeQueriesHook;
