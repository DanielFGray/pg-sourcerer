/**
 * SQL Queries Plugin - Generate raw SQL query functions using template strings
 *
 * Generates SQL query functions with tagged template literals.
 * Uses parameterized queries ($1, $2, etc.) for safety.
 */
import { Effect, Match, Predicate, Schema as S, pipe, Array as Arr, Option } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../runtime/types.js";
import type { RenderedSymbol } from "../runtime/types.js";
import type { FileNaming } from "../runtime/file-assignment.js";
import { normalizeFileNaming } from "../runtime/file-assignment.js";
import { IR } from "../services/ir.js";
import { CoreInflection, Inflection } from "../services/inflection.js";
import {
  getTableEntities,
  getCursorPaginationCandidates,
  type TableEntity,
  type Field,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, EntityQueriesExtension } from "../ir/extensions/queries.js";
import { type UserModuleRef } from "../user-module.js";
import { getPgType, pgTypeToTsType, resolveFieldTypeInfo } from "./shared/pg-types.js";

const { fn, ts, param, b } = conjure;

const createQueryConsume =
  (method: QueryMethod) =>
  (input: unknown): n.Expression => {
    const args = input == null ? [] : [cast.toExpr(input as n.Expression)];
    return b.callExpression(b.identifier(method.name), args);
  };

/** Result of generating a query symbol - may include both a symbol and a method */
interface QueryGenResult {
  readonly symbols: readonly RenderedSymbol[];
  readonly methods: readonly QueryMethod[];
}

const emptyResult: QueryGenResult = { symbols: [], methods: [] };

const combineResults = (results: readonly QueryGenResult[]): QueryGenResult =>
  results.reduce(
    (acc, r) => ({
      symbols: [...acc.symbols, ...r.symbols],
      methods: [...acc.methods, ...r.methods],
    }),
    emptyResult,
  );

// ============================================================================
// Name Building Helpers
// ============================================================================

function buildQueryName(inflection: CoreInflection, entityName: string, operation: string): string {
  return inflection.variableName(entityName, operation);
}

function buildFindByName(
  inflection: CoreInflection,
  entityName: string,
  columnName: string,
): string {
  return inflection.variableName(entityName, `FindBy${inflection.pascalCase(columnName)}`);
}

function buildListByName(
  inflection: CoreInflection,
  entityName: string,
  columnName: string,
): string {
  return inflection.variableName(entityName, `ListBy${inflection.pascalCase(columnName)}`);
}

function getResolvedTypeName(field: Field): string {
  const resolved = resolveFieldTypeInfo(field);
  return resolved?.typeName ?? getPgType(field);
}

// ============================================================================
// Configuration
// ============================================================================

const SqlQueriesConfigSchema = S.Struct({
  /** Generate query functions (default: true) */
  generateQueries: S.optionalWith(S.Boolean, { default: () => true }),
  /** SQL query style - always "tag" for template literals */
  sqlStyle: S.optionalWith(S.Literal("tag"), { default: () => "tag" as const }),
  /** Use explicit column lists instead of SELECT * (default: true) */
  explicitColumns: S.optionalWith(S.Boolean, { default: () => true }),
  /** Default limit for list queries (default: 50) */
  defaultLimit: S.optionalWith(S.Number, { default: () => 50 }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof SqlQueriesConfigSchema>;

/**
 * SQL Queries plugin configuration.
 *
 * @example
 * // With SQL client import (recommended)
 * sqlQueries({
 *   sqlImport: userModule("./db.ts", { named: ["sql"] }),
 * })
 */
export interface SqlQueriesConfig {
  /** Generate query functions (default: true) */
  generateQueries?: boolean;
  /**
   * Import for the SQL client.
   * Use userModule() helper to specify the path relative to your config file.
   *
   * @example
   * ```typescript
   * import { userModule } from "pg-sourcerer";
   *
   * sqlQueries({
   *   sqlImport: userModule("./db.ts", { named: ["sql"] }),
   * })
   * ```
   */
  sqlImport?: UserModuleRef;
  /** SQL query style - always "tag" for template literals */
  sqlStyle?: "tag";
  /** Use explicit column lists instead of SELECT * (default: true) */
  explicitColumns?: boolean;
  /** Default limit for list queries (default: 50) */
  defaultLimit?: number;
  /**
   * Output file path for queries.
   * Can be a string (static path) or function (dynamic per entity).
   * @default "queries.ts"
   */
  queriesFile?: string | FileNaming;
}

/** Resolved config with defaults applied */
interface ResolvedSqlQueriesConfig extends SchemaConfig {
  queriesFile: FileNaming;
  sqlImport?: UserModuleRef;
}

// ============================================================================
// Query Generation Helpers
// ============================================================================

function buildColumnList(fields: readonly Field[]): string {
  return fields.map(f => f.columnName).join(", ");
}

function buildSelectClause(entity: TableEntity, explicitColumns: boolean): string {
  return explicitColumns ? `select ${buildColumnList(entity.shapes.row.fields)}` : "select *";
}

function buildTableName(entity: TableEntity, defaultSchemas: readonly string[]): string {
  return defaultSchemas.includes(entity.schemaName)
    ? entity.pgName
    : `${entity.schemaName}.${entity.pgName}`;
}

function buildPkParam(field: Field) {
  return {
    name: field.name,
    type: pgTypeToTsType(getResolvedTypeName(field)),
    required: true,
    columnName: field.columnName,
    source: "pk" as const,
  };
}

function buildLookupParam(field: Field) {
  return {
    name: field.name,
    type: pgTypeToTsType(getResolvedTypeName(field)),
    required: true,
    columnName: field.columnName,
    source: "lookup" as const,
  };
}

interface BodyParam {
  name: string;
  type: string;
  wrapper: "Insertable" | "Updateable";
  entityType: string;
  required: boolean;
  source: "body";
}

function buildBodyParam(entityName: string, shape: "insert" | "update"): BodyParam {
  const wrapper = shape === "insert" ? "Insertable" : "Updateable";
  return {
    name: "data",
    type: `${wrapper}<${entityName}>`,
    wrapper,
    entityType: entityName,
    required: true,
    source: "body" as const,
  };
}

interface PaginationParam {
  name: string;
  type: string;
  required: false;
  defaultValue: number;
  source: "pagination";
}

function buildReturnType(entityName: string, isArray: boolean, nullable: boolean) {
  return {
    type: entityName,
    nullable,
    isArray,
  };
}

// Query name helpers removed - now using inflection service:
// - inflection.queryFunctionName(entity, operation)
// - inflection.queryFindByName(entity, column)
// - inflection.queryListByName(entity, column)

interface SimpleParam {
  name: string;
  type: string;
  required?: boolean;
}

type AnyParam = SimpleParam | BodyParam | PaginationParam;

function isBodyParam(p: AnyParam): p is BodyParam {
  return "wrapper" in p;
}

function isPaginationParam(p: AnyParam): p is PaginationParam {
  return "defaultValue" in p;
}

function buildParamType(p: AnyParam): n.TSType {
  if (isBodyParam(p)) {
    return ts.ref(p.wrapper, [ts.ref(p.entityType)]);
  }
  return ts.ref(p.type);
}

function buildDestructuredParam(params: readonly AnyParam[]): n.ObjectPattern {
  return param.destructured(
    params.map(p => ({
      name: p.name,
      type: buildParamType(p),
      optional: "required" in p ? p.required === false : false,
      defaultValue: isPaginationParam(p) ? conjure.num(p.defaultValue) : undefined,
    })),
  );
}

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * SQL Queries plugin - generates raw SQL query functions with tagged templates.
 *
 * Capabilities provided:
 * - `queries:sql:EntityName:operation` - CRUD query functions
 */
export function sqlQueries(config?: SqlQueriesConfig): Plugin {
  const schemaConfig = S.decodeSync(SqlQueriesConfigSchema)(config ?? {});

  const queriesFile = normalizeFileNaming(config?.queriesFile, "queries.ts");

  const resolvedConfig: ResolvedSqlQueriesConfig = {
    ...schemaConfig,
    queriesFile,
  };

  const queriesFilePath = typeof queriesFile === "string" ? queriesFile : "queries.ts";

  return {
    name: "sql-queries",
    provides: ["queries"],
    consumes: [],

    fileDefaults: [
      {
        pattern: "queries:sql:",
        fileNaming: resolvedConfig.queriesFile,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;
      const inflection = yield* Inflection;

      if (!resolvedConfig.generateQueries) return [];

      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);

      const hasPrimaryKey = (entity: TableEntity) =>
        entity.primaryKey && entity.primaryKey.columns.length > 0;

      const isValidIndex = (index: TableEntity["indexes"][number]) =>
        !index.isPartial &&
        !index.hasExpressions &&
        index.columns.length === 1 &&
        index.method !== "gin" &&
        index.method !== "gist";

      return tableEntities.flatMap(entity => {
        const entityName = entity.name;

        const findByIdDecl =
          entity.permissions.canSelect && hasPrimaryKey(entity)
            ? [
                {
                  name: buildQueryName(inflection, entityName, "FindById"),
                  capability: `queries:sql:${entityName}:findById`,
                },
              ]
            : [];

        const createDecl =
          entity.kind === "table" && entity.permissions.canInsert && entity.shapes.insert
            ? [
                {
                  name: buildQueryName(inflection, entityName, "Create"),
                  capability: `queries:sql:${entityName}:create`,
                },
              ]
            : [];

        const updateDecl =
          entity.kind === "table" &&
          entity.permissions.canUpdate &&
          entity.shapes.update &&
          hasPrimaryKey(entity)
            ? [
                {
                  name: buildQueryName(inflection, entityName, "Update"),
                  capability: `queries:sql:${entityName}:update`,
                },
              ]
            : [];

        const deleteDecl =
          entity.kind === "table" && entity.permissions.canDelete && hasPrimaryKey(entity)
            ? [
                {
                  name: buildQueryName(inflection, entityName, "Delete"),
                  capability: `queries:sql:${entityName}:delete`,
                },
              ]
            : [];

        const pkColumns = new Set(entity.primaryKey?.columns ?? []);
        const findByIndexDecls = entity.permissions.canSelect
          ? entity.indexes
              .filter(isValidIndex)
              .map(index => index.columns[0]!)
              .filter(columnName => !pkColumns.has(columnName))
              .filter((columnName, i, arr) => arr.indexOf(columnName) === i) // dedupe
              .map(columnName => ({
                name: buildFindByName(inflection, entityName, columnName),
                capability: `queries:sql:${entityName}:findBy${inflection.pascalCase(columnName)}`,
              }))
          : [];

        const cursorDecls = getCursorPaginationCandidates(entity).map(candidate => ({
          name: buildListByName(inflection, entityName, candidate.cursorColumnName),
          capability: `queries:sql:${entityName}:listBy${inflection.pascalCase(candidate.cursorColumnName)}`,
        }));

        const methodDecls = [
          ...findByIdDecl,
          ...createDecl,
          ...updateDecl,
          ...deleteDecl,
          ...findByIndexDecls,
          ...cursorDecls,
        ];

        return methodDecls.length > 0
          ? [
              ...methodDecls,
              {
                name: `${entityName}Queries`,
                capability: `queries:sql:${entityName}`,
              },
            ]
          : [];
      });
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const inflection = yield* Inflection;

      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);
      const defaultSchemas = ir.schemas;

      const queryUserImports: readonly UserModuleRef[] | undefined = resolvedConfig.sqlImport
        ? [resolvedConfig.sqlImport]
        : undefined;

      if (!resolvedConfig.generateQueries) {
        return [];
      }

      const buildTemplateLiteral = (parts: readonly string[]): n.TaggedTemplateExpression =>
        conjure.taggedTemplate("sql", parts, []);

      const buildTemplateLiteralWithParams = (
        parts: readonly string[],
        params: readonly n.Expression[],
      ): n.TaggedTemplateExpression => conjure.taggedTemplate("sql", parts, [...params]);

      const generateFindById = (
        entity: TableEntity,
        entityName: string,
        selectClause: string,
        fromClause: string,
      ): QueryGenResult => {
        if (!entity.permissions.canSelect || !entity.primaryKey?.columns[0]) return emptyResult;

        const pkColumn = entity.primaryKey.columns[0];
        const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
        if (!pkField) return emptyResult;

        const pkParam = buildPkParam(pkField);
        const method: QueryMethod = {
          name: buildQueryName(inflection, entityName, "FindById"),
          kind: "read",
          params: [pkParam],
          returns: buildReturnType(entityName, false, true),
          callSignature: { style: "named" },
        };

        const templateLiteral = buildTemplateLiteral([
          `${selectClause} ${fromClause} where ${pkColumn} = `,
          "",
        ]);
        const fnExpr = fn()
          .rawParam(buildDestructuredParam([pkParam]))
          .arrow()
          .body(conjure.stmt.return(templateLiteral))
          .build();

        return {
          methods: [method],
          symbols: [
            {
              name: method.name,
              capability: `queries:sql:${entityName}:findById`,
              node: conjure.export.const(method.name, fnExpr),
              metadata: { consume: createQueryConsume(method) },
              exports: "named",
              userImports: queryUserImports,
            },
          ],
        };
      };

      const generateCreate = (
        entity: TableEntity,
        entityName: string,
        tableName: string,
      ): QueryGenResult => {
        if (entity.kind !== "table" || !entity.permissions.canInsert || !entity.shapes.insert) {
          return emptyResult;
        }

        const bodyParam = buildBodyParam(entityName, "insert");
        const method: QueryMethod = {
          name: buildQueryName(inflection, entityName, "Create"),
          kind: "create",
          params: [bodyParam],
          returns: buildReturnType(entityName, false, false),
          callSignature: { style: "named", bodyStyle: "property" },
        };

        const insertableFields = entity.shapes.insert.fields.filter(f => f.permissions.canInsert);
        const columnList = insertableFields.map(f => f.columnName).join(", ");
        const templateParts = [
          `insert into ${tableName} (${columnList}) values (`,
          "",
          ...insertableFields.slice(1).map(() => ", "),
          ") returning *",
        ];

        const paramExprs = insertableFields.map(f =>
          b.memberExpression(b.identifier("data"), b.identifier(f.name)),
        );
        const fnExpr = fn()
          .rawParam(buildDestructuredParam([bodyParam]))
          .arrow()
          .body(conjure.stmt.return(buildTemplateLiteralWithParams(templateParts, paramExprs)))
          .build();

        return {
          methods: [method],
          symbols: [
            {
              name: method.name,
              capability: `queries:sql:${entityName}:create`,
              node: conjure.export.const(method.name, fnExpr),
              metadata: { consume: createQueryConsume(method) },
              exports: "named",
              imports: [{ from: queriesFilePath, types: [entityName] }],
              userImports: queryUserImports,
            },
          ],
        };
      };

      const generateUpdate = (
        entity: TableEntity,
        entityName: string,
        tableName: string,
      ): QueryGenResult => {
        if (
          entity.kind !== "table" ||
          !entity.permissions.canUpdate ||
          !entity.shapes.update ||
          !entity.primaryKey?.columns[0]
        ) {
          return emptyResult;
        }

        const pkColumn = entity.primaryKey.columns[0];
        const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
        if (!pkField) return emptyResult;

        const pkParam = buildPkParam(pkField);
        const bodyParam = buildBodyParam(entityName, "update");
        const method: QueryMethod = {
          name: buildQueryName(inflection, entityName, "Update"),
          kind: "update",
          params: [pkParam, bodyParam],
          returns: buildReturnType(entityName, false, true),
          callSignature: { style: "named", bodyStyle: "property" },
        };

        const updatableFields = entity.shapes.update.fields.filter(f => f.permissions.canUpdate);
        const templateParts = [
          `update ${tableName} set `,
          ...updatableFields.map((f, i) => (i === 0 ? `${f.columnName} = ` : `, ${f.columnName} = `)),
          ` where ${pkColumn} = `,
          " returning *",
        ];

        const paramExprs = [
          ...updatableFields.map(f =>
            b.memberExpression(b.identifier("data"), b.identifier(f.name)),
          ),
          b.identifier(pkField.name),
        ];
        const fnExpr = fn()
          .rawParam(buildDestructuredParam([pkParam, bodyParam]))
          .arrow()
          .body(conjure.stmt.return(buildTemplateLiteralWithParams(templateParts, paramExprs)))
          .build();

        return {
          methods: [method],
          symbols: [
            {
              name: method.name,
              capability: `queries:sql:${entityName}:update`,
              node: conjure.export.const(method.name, fnExpr),
              metadata: { consume: createQueryConsume(method) },
              exports: "named",
              imports: [{ from: queriesFilePath, types: [entityName] }],
              userImports: queryUserImports,
            },
          ],
        };
      };

      const generateDelete = (
        entity: TableEntity,
        entityName: string,
        tableName: string,
      ): QueryGenResult => {
        if (entity.kind !== "table" || !entity.permissions.canDelete || !entity.primaryKey?.columns[0]) {
          return emptyResult;
        }

        const pkColumn = entity.primaryKey.columns[0];
        const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
        if (!pkField) return emptyResult;

        const pkParam = buildPkParam(pkField);
        const method: QueryMethod = {
          name: buildQueryName(inflection, entityName, "Delete"),
          kind: "delete",
          params: [pkParam],
          returns: buildReturnType(entityName, false, false),
          callSignature: { style: "named" },
        };

        const fnExpr = fn()
          .rawParam(buildDestructuredParam([pkParam]))
          .arrow()
          .body(
            conjure.stmt.return(
              buildTemplateLiteral([`delete from ${tableName} where ${pkColumn} = `, ""]),
            ),
          )
          .build();

        return {
          methods: [method],
          symbols: [
            {
              name: method.name,
              capability: `queries:sql:${entityName}:delete`,
              node: conjure.export.const(method.name, fnExpr),
              metadata: { consume: createQueryConsume(method) },
              exports: "named",
              userImports: queryUserImports,
            },
          ],
        };
      };

      const generateFindByIndexes = (
        entity: TableEntity,
        entityName: string,
        selectClause: string,
        fromClause: string,
      ): QueryGenResult => {
        if (!entity.permissions.canSelect) return emptyResult;

        const pkColumns = new Set(entity.primaryKey?.columns ?? []);
        const isValidIndex = (index: TableEntity["indexes"][number]) =>
          !index.isPartial &&
          !index.hasExpressions &&
          index.columns.length === 1 &&
          index.method !== "gin" &&
          index.method !== "gist";

        return pipe(
          entity.indexes,
          Arr.filter(isValidIndex),
          Arr.map(index => ({ index, columnName: index.columns[0]! })),
          Arr.filter(({ columnName }) => !pkColumns.has(columnName)),
          Arr.dedupeWith((a, b) => a.columnName === b.columnName),
          Arr.filterMap(({ index, columnName }) =>
            pipe(
              entity.shapes.row.fields.find(f => f.columnName === columnName),
              Option.fromNullable,
              Option.map(field => {
                const pascalColumn = inflection.pascalCase(columnName);
                const lookupParam = buildLookupParam(field);
                const method: QueryMethod = {
                  name: buildFindByName(inflection, entityName, columnName),
                  kind: "lookup",
                  params: [lookupParam],
                  returns: buildReturnType(entityName, !index.isUnique, index.isUnique),
                  lookupField: field.name,
                  isUniqueLookup: index.isUnique,
                  callSignature: { style: "named" },
                };

                const fnExpr = fn()
                  .rawParam(buildDestructuredParam([lookupParam]))
                  .arrow()
                  .body(
                    conjure.stmt.return(
                      buildTemplateLiteral([`${selectClause} ${fromClause} where ${columnName} = `, ""]),
                    ),
                  )
                  .build();

                return {
                  methods: [method],
                  symbols: [
                    {
                      name: method.name,
                      capability: `queries:sql:${entityName}:findBy${pascalColumn}`,
                      node: conjure.export.const(method.name, fnExpr),
                      metadata: { consume: createQueryConsume(method) },
                      exports: "named" as const,
                      userImports: queryUserImports,
                    },
                  ],
                } satisfies QueryGenResult;
              }),
            ),
          ),
          combineResults,
        );
      };

      const generateCursorPagination = (
        entity: TableEntity,
        entityName: string,
        selectClause: string,
        fromClause: string,
      ): QueryGenResult =>
        pipe(
          getCursorPaginationCandidates(entity),
          Arr.filterMap(candidate =>
            pipe(
              entity.shapes.row.fields.find(f => f.name === candidate.pkColumn),
              Option.fromNullable,
              Option.map(pkField => {
                const pascalColumn = inflection.pascalCase(candidate.cursorColumnName);
                const pkParamType = pgTypeToTsType(getResolvedTypeName(pkField));

                const cursorParam = {
                  name: inflection.camelCase(`cursor_${candidate.cursorColumnName}`),
                  type: "Date",
                  required: false,
                  source: "pagination" as const,
                };
                const cursorPkParam = {
                  name: inflection.camelCase(`cursor_${candidate.pkColumnName}`),
                  type: pkParamType,
                  required: false,
                  source: "pagination" as const,
                };
                const limitParam = {
                  name: "limit",
                  type: "number",
                  required: false,
                  defaultValue: resolvedConfig.defaultLimit,
                  source: "pagination" as const,
                };

                const method: QueryMethod = {
                  name: buildListByName(inflection, entityName, candidate.cursorColumnName),
                  kind: "list",
                  params: [cursorParam, cursorPkParam, limitParam],
                  returns: buildReturnType(entityName, true, false),
                  callSignature: { style: "named" },
                };

                const operator = candidate.desc ? "<" : ">";
                const orderDirection = candidate.desc ? "DESC" : "ASC";
                const templateParts = [
                  `${selectClause} ${fromClause} where ($`,
                  `::timestamptz IS NULL OR (${candidate.cursorColumnName}, ${candidate.pkColumnName}) ${operator} ($`,
                  `, `,
                  `)) order by ${candidate.cursorColumnName} ${orderDirection}, ${candidate.pkColumnName} ${orderDirection} limit `,
                ];

                const fnExpr = fn()
                  .rawParam(buildDestructuredParam([cursorParam, cursorPkParam, limitParam]))
                  .arrow()
                  .body(
                    conjure.stmt.return(
                      buildTemplateLiteralWithParams(templateParts, [
                        b.identifier(cursorParam.name),
                        b.identifier(cursorPkParam.name),
                        b.identifier("limit"),
                      ]),
                    ),
                  )
                  .build();

                return {
                  methods: [method],
                  symbols: [
                    {
                      name: method.name,
                      capability: `queries:sql:${entityName}:listBy${pascalColumn}`,
                      node: conjure.export.const(method.name, fnExpr),
                      exports: "named" as const,
                      userImports: queryUserImports,
                    },
                  ],
                } satisfies QueryGenResult;
              }),
            ),
          ),
          combineResults,
        );

      const generateEntitySymbols = (entity: TableEntity): RenderedSymbol[] => {
        const entityName = entity.name;
        const tableName = buildTableName(entity, defaultSchemas);
        const selectClause = buildSelectClause(entity, resolvedConfig.explicitColumns);
        const fromClause = `from ${tableName}`;

        const results = combineResults([
          generateFindById(entity, entityName, selectClause, fromClause),
          generateCreate(entity, entityName, tableName),
          generateUpdate(entity, entityName, tableName),
          generateDelete(entity, entityName, tableName),
          generateFindByIndexes(entity, entityName, selectClause, fromClause),
          generateCursorPagination(entity, entityName, selectClause, fromClause),
        ]);

        const pkField = entity.primaryKey?.columns[0]
          ? entity.shapes.row.fields.find(f => f.columnName === entity.primaryKey!.columns[0])
          : undefined;

        const entityExtension: EntityQueriesExtension = {
          methods: [...results.methods],
          pkType: pkField ? pgTypeToTsType(getResolvedTypeName(pkField)) : undefined,
          hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
        };

        return [
          ...results.symbols,
          {
            name: `${entityName}Queries`,
            capability: `queries:sql:${entityName}`,
            node: b.emptyStatement(),
            metadata: entityExtension,
            exports: false,
          },
        ];
      };

      return tableEntities.flatMap(generateEntitySymbols);
    }),
  };
}
