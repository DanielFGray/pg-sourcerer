// @ts-check
import partition from "lodash.partition";
import groupBy from "lodash.groupby";
import _debug from "debug";
import invariant from "tiny-invariant";
import * as utils from "../utils/index.mjs";

const debug = _debug("pg-sourcerer");

/**
 * @typedef {{
 *   name: string;
 *   operation: "select" | "insert" | "update" | "delete" | "function"
 *   params: Record<string, { default?: any; type: string, Pick?: Array<string> }>;
 *   where?: Array<[string, string, string]>;
 *   join?: Array<string>;
 *   order?: Array<string>;
 *   returnType?: string;
 *   returnsMany?: boolean;
 *   schema: string;
 *   identifier: string;
 * }} QueryData
 */

/**
 * @param {QueryData} queryData
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
        const values = patch?.map(() => "?").join(", ");
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
        params.push(...queryData.where?.map(([v]) => v));
        return [
          `update ${target}`,
          `set ${values}`,
          queryData.where && `where ${queryData.where.map(p => p.join(" ")).join(" and ")}`,
        ];
      }
      case "delete": {
        params.push(...queryData.where?.map(([v]) => v));
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
/**
 * @param {{
 *   queryData: Array<QueryData>;
 *   name: string;
 *   adapter: 'pg' | 'postgres'
 *   inflections: import("../utils/index.mjs").Inflections
 * }} _
 */
function queryDataToObjectMethodsAST({ queryData, name, inflections, adapter }) {
  const b = utils.builders;

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
                  properties: Object.entries(queryData.params).flatMap(([name, v]) =>
                    name === "patch" && v.Pick
                      ? v.Pick.map(key =>
                          b.property.from({
                            kind: "init",
                            key: b.identifier(key),
                            shorthand: true,
                            value: b.identifier(key),
                          }),
                        )
                      : b.property.from({
                          kind: "init",
                          key: b.identifier(name),
                          value:
                            v.default != null && v.default !== ""
                              ? b.assignmentPattern(b.identifier(name), b.literal(v.default))
                              : b.identifier(name),
                          shorthand: true,
                        }),
                  ),
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
                      : null,
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

/**
 * @type {(opts: {
 *   schemas: Array<string>,
 *   tables?: Array<string>,
 *   path?: string | ((o: { schema: string, name: string }) => string),
 * }) => import("../index.mjs").Plugin}
 */
export const makeQueriesPlugin = pluginOpts => ({
  name: "queries",
  inflections: {
    identifiers: ["camelize"],
    methods: ["camelize"],
  },
  render({ introspection, config, output }) {
    return Object.values(introspection.schemas)
      .filter(schema => pluginOpts.schemas?.includes(schema.name) ?? true)
      .map(schema => {
        invariant(
          typeof config.inflections.identifiers === "function",
          "failed to register inflection",
        );
        invariant(
          typeof config.inflections.methods === "function",
          "failed to register inflection",
        );
        invariant(typeof config.inflections.types === "function", "failed to register inflection");
        invariant(
          typeof config.inflections.columns === "function",
          "failed to register inflection",
        );
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
        const _computedByTables = groupBy(computed, ([_, fn]) => fn.args[0]?.[1].type);
        const _fnQueries = procs.map(
          ([name, fn]) =>
            /** @type QueryData */ ({
              name: config.inflections.methods(name),
              operation: "select",
              schema: schema.name,
              identifier: name,
              returnsMany: fn.returnType,
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
              const [column] = index.colnames.map(n => table.columns[n]);
              const identifier = table.name;
              const schemaName = schema.name;
              const returnType = config.inflections.types(table.name);
              const pgTypeName = utils.getTSTypeNameFromPgType(column.type, config);
              if (index.colnames.length > 1) {
                console.log(column);
              } else {
                const columnName = config.inflections.columns(column.name);
                switch (true) {
                  case index.isPrimary:
                    return /** @type QueryData[] */ ([
                      ...(!table.permissions.canSelect
                        ? []
                        : [
                            {
                              name: config.inflections.methods(`by_${column.name}`),
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
                    ]);
                  case column.type === "pg_catalog.tsvector":
                    return /** @type {QueryData[]} */ ([
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
                    ]);
                  case column.type === "pg_catalog.timestamptz":
                    const name =
                      column.name === "created_at" && index.option?.[0] === 3
                        ? "latest"
                        : `by_${columnName}`;

                    return /** @type {QueryData[]} */ ([
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
                    ]);
                  default:
                    return /** @type {QueryData[]} */ (
                      utils.getOperatorsFrom({ column, index }).map(operator => ({
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
                      }))
                    );
                }
              }
            }),
          );
        return tables;
      })
      .filter(Boolean)
      .flatMap(q =>
        q.flatMap(queryData => {
          const first = queryData[0];
          if (!first) return [];
          const { identifier, schema } = first;
          const typeRef = utils.findExports({
            output,
            identifier: config.inflections.types(identifier),
            kind: "type",
          });
          const exportPath = utils.makePathFromConfig({
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
          return /** @type {import("../index.mjs").Output} */ ({
            path: exportPath,
            imports: [
              pluginOpts.adapter === "pg"
                ? {
                    identifier: "pg",
                    typeImport: true,
                    default: true,
                    path: "pg",
                  }
                : {
                    identifier: "Sql",
                    typeImport: true,
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
              adapter: pluginOpts.adapter,
            }),
          });
        }),
      );
  },
});
