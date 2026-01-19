/**
 * SQL Queries Plugin - Generate raw SQL query functions using template strings
 *
 * Generates SQL query functions with tagged template literals.
 * Uses parameterized queries ($1, $2, etc.) for safety.
 */
import { Effect, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import type { RenderedSymbolWithImports, ExternalImport } from "../runtime/emit.js";
import type { FileNaming } from "../runtime/file-assignment.js";
import { normalizeFileNaming } from "../runtime/file-assignment.js";
import { IR } from "../services/ir.js";
import {
  isTableEntity,
  getTableEntities,
  getEnumEntities,
  type TableEntity,
  type EnumEntity,
  type Field,
} from "../ir/semantic-ir.js";
import { conjure } from "../conjure/index.js";
import type { QueryMethod, EntityQueriesExtension } from "../ir/extensions/queries.js";

const { fn, ts, param, str, b, exp } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const SqlQueriesConfigSchema = S.Struct({
  /** Generate query functions (default: true) */
  generateQueries: S.optionalWith(S.Boolean, { default: () => true }),
  /** Header to prepend to generated files (use for sql import) */
  header: S.optionalWith(S.String, { default: () => "" }),
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
 */
export interface SqlQueriesConfig {
  /** Generate query functions (default: true) */
  generateQueries?: boolean;
  /** Header to prepend to generated files (use for sql import) */
  header?: string;
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
}

// ============================================================================
// Query Generation Helpers
// ============================================================================

function buildColumnList(fields: readonly Field[]): string {
  return fields.map(f => f.columnName).join(", ");
}

function buildSelectClause(entity: TableEntity, explicitColumns: boolean): string {
  return explicitColumns
    ? `select ${buildColumnList(entity.shapes.row.fields)}`
    : "select *";
}

function buildTableName(entity: TableEntity, defaultSchemas: readonly string[]): string {
  return defaultSchemas.includes(entity.schemaName)
    ? entity.pgName
    : `${entity.schemaName}.${entity.pgName}`;
}

function getPgType(field: Field): string {
  const pgType = field.pgAttribute.getType();
  return pgType?.typname ?? "unknown";
}

function pgTypeToTsType(pgType: string): string {
  const lower = pgType.toLowerCase();
  if (["uuid", "text", "varchar", "char", "citext", "name"].includes(lower)) return "string";
  if (
    ["int2", "int4", "int8", "integer", "smallint", "bigint", "numeric", "decimal", "real", "float4", "float8"].includes(
      lower,
    )
  )
    return "number";
  if (["bool", "boolean"].includes(lower)) return "boolean";
  if (["timestamp", "timestamptz", "date"].includes(lower)) return "Date";
  if (["json", "jsonb"].includes(lower)) return "unknown";
  return "string";
}

function buildPkParam(field: Field) {
  return {
    name: field.name,
    type: pgTypeToTsType(getPgType(field)),
    required: true,
    columnName: field.columnName,
    source: "pk" as const,
  };
}

function buildLookupParam(field: Field) {
  return {
    name: field.name,
    type: pgTypeToTsType(getPgType(field)),
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

function buildPaginationParams(defaultLimit: number): PaginationParam[] {
  return [
    { name: "limit", type: "number", required: false, defaultValue: defaultLimit, source: "pagination" as const },
    { name: "offset", type: "number", required: false, defaultValue: 0, source: "pagination" as const },
  ];
}

function buildReturnType(entityName: string, isArray: boolean, nullable: boolean) {
  return {
    type: entityName,
    nullable,
    isArray,
  };
}

function buildQueryName(entityName: string, operation: string): string {
  const lowerEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  return `${lowerEntity}${operation.charAt(0).toUpperCase() + operation.slice(1)}`;
}

function buildFindByQueryName(entityName: string, columnName: string): string {
  const lowerEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const pascalColumn = columnName
    .split("_")
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return `${lowerEntity}FindBy${pascalColumn}`;
}

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
      const declarations: SymbolDeclaration[] = [];

      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);

      if (resolvedConfig.generateQueries) {
        for (const entity of tableEntities) {
          const entityName = entity.name;
          let hasAnyMethods = false;

          if (entity.permissions.canSelect && entity.primaryKey && entity.primaryKey.columns.length > 0) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "findById"),
              capability: `queries:sql:${entityName}:findById`,
            });
          }

          if (entity.permissions.canSelect) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "list"),
              capability: `queries:sql:${entityName}:list`,
            });
          }

          if (entity.kind === "table" && entity.permissions.canInsert && entity.shapes.insert) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "create"),
              capability: `queries:sql:${entityName}:create`,
            });
          }

          if (
            entity.kind === "table" &&
            entity.permissions.canUpdate &&
            entity.shapes.update &&
            entity.primaryKey &&
            entity.primaryKey.columns.length > 0
          ) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "update"),
              capability: `queries:sql:${entityName}:update`,
            });
          }

          if (
            entity.kind === "table" &&
            entity.permissions.canDelete &&
            entity.primaryKey &&
            entity.primaryKey.columns.length > 0
          ) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "delete"),
              capability: `queries:sql:${entityName}:delete`,
            });
          }

          if (entity.permissions.canSelect) {
            const pkColumns = new Set(entity.primaryKey?.columns ?? []);
            const processedColumns = new Set<string>();
            for (const index of entity.indexes) {
              if (index.isPartial || index.hasExpressions || index.columns.length !== 1) continue;
              if (index.method === "gin" || index.method === "gist") continue;

              const columnName = index.columns[0]!;
              if (pkColumns.has(columnName)) continue;
              if (processedColumns.has(columnName)) continue;
              processedColumns.add(columnName);

              const pascalColumn = columnName
                .split("_")
                .map(s => s.charAt(0).toUpperCase() + s.slice(1))
                .join("");
              hasAnyMethods = true;
              declarations.push({
                name: buildFindByQueryName(entityName, columnName),
                capability: `queries:sql:${entityName}:findBy${pascalColumn}`,
              });
            }
          }

          if (hasAnyMethods) {
            declarations.push({
              name: `${entityName}Queries`,
              capability: `queries:sql:${entityName}`,
            });
          }
        }
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const symbols: RenderedSymbolWithImports[] = [];

      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);
      const defaultSchemas = ir.schemas;

      const queryHeader = resolvedConfig.header || `import { sql } from "postgres";\n`;

      if (resolvedConfig.generateQueries) {
        for (const entity of tableEntities) {
          const entityName = entity.name;
          const tableName = buildTableName(entity, defaultSchemas);
          const selectClause = buildSelectClause(entity, resolvedConfig.explicitColumns);

          const entityMethods: QueryMethod[] = [];

          const fromClause = `from ${tableName}`;

          const buildTemplateLiteral = (
            parts: readonly string[],
          ): n.TaggedTemplateExpression => {
            return conjure.taggedTemplate("sql", parts, []);
          };

          const buildTemplateLiteralWithParams = (
            parts: readonly string[],
            params: readonly n.Expression[],
          ): n.TaggedTemplateExpression => {
            return conjure.taggedTemplate("sql", parts, [...params]);
          };

          if (entity.permissions.canSelect && entity.primaryKey && entity.primaryKey.columns.length > 0) {
            const pkColumn = entity.primaryKey.columns[0]!;
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn)!;
            const pkParam = buildPkParam(pkField);

            const method: QueryMethod = {
              name: buildQueryName(entityName, "findById"),
              kind: "read",
              params: [pkParam],
              returns: buildReturnType(entityName, false, true),
              callSignature: { style: "named" },
            };
            entityMethods.push(method);

            const templateLiteral = buildTemplateLiteral([
              `${selectClause} ${fromClause} where ${pkColumn} = `,
              "",
            ]);

            const destructuredParam = buildDestructuredParam([pkParam]);
            const fnExpr = fn().rawParam(destructuredParam).arrow().body(
              conjure.stmt.return(templateLiteral),
            ).build();

            symbols.push({
              name: method.name,
              capability: `queries:sql:${entityName}:findById`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              fileHeader: queryHeader,
            });
          }

          if (entity.permissions.canSelect) {
            const paginationParams = buildPaginationParams(resolvedConfig.defaultLimit);
            const method: QueryMethod = {
              name: buildQueryName(entityName, "list"),
              kind: "list",
              params: paginationParams as unknown as QueryMethod["params"],
              returns: buildReturnType(entityName, true, false),
              callSignature: { style: "named" },
            };
            entityMethods.push(method);

            const templateLiteral = buildTemplateLiteral([
              `${selectClause} ${fromClause} limit `,
              " offset ",
              "",
            ]);

            const destructuredParam = buildDestructuredParam(paginationParams);
            const fnExpr = fn().rawParam(destructuredParam).arrow().body(
              conjure.stmt.return(templateLiteral),
            ).build();

            symbols.push({
              name: method.name,
              capability: `queries:sql:${entityName}:list`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              fileHeader: queryHeader,
            });
          }

          if (entity.kind === "table" && entity.permissions.canInsert && entity.shapes.insert) {
            const bodyParam = buildBodyParam(entityName, "insert");
            const method: QueryMethod = {
              name: buildQueryName(entityName, "create"),
              kind: "create",
              params: [bodyParam],
              returns: buildReturnType(entityName, false, false),
              callSignature: { style: "named", bodyStyle: "property" },
            };
            entityMethods.push(method);

            const insertableFields = entity.shapes.insert.fields.filter(f => f.permissions.canInsert);
            const columnNames = insertableFields.map(f => f.columnName);
            const columnList = columnNames.join(", ");

            const templateParts: string[] = [`insert into ${tableName} (${columnList}) values (`];
            for (let i = 0; i < insertableFields.length; i++) {
              if (i === 0) {
                templateParts.push("");
              } else {
                templateParts.push(", ");
              }
            }
            templateParts.push(") returning *");

            const paramExprs: n.Expression[] = insertableFields.map(f =>
              b.memberExpression(b.identifier("data"), b.identifier(f.name)),
            );
            const templateLiteral = buildTemplateLiteralWithParams(templateParts, paramExprs);

            const destructuredParam = buildDestructuredParam([bodyParam]);
            const fnExpr = fn().rawParam(destructuredParam).arrow().body(
              conjure.stmt.return(templateLiteral),
            ).build();

            symbols.push({
              name: method.name,
              capability: `queries:sql:${entityName}:create`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: [
                {
                  from: queriesFilePath,
                  types: [entityName],
                },
              ],
              fileHeader: queryHeader,
            });
          }

          if (
            entity.kind === "table" &&
            entity.permissions.canUpdate &&
            entity.shapes.update &&
            entity.primaryKey &&
            entity.primaryKey.columns.length > 0
          ) {
            const pkColumn = entity.primaryKey.columns[0]!;
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn)!;
            const pkParam = buildPkParam(pkField);
            const bodyParam = buildBodyParam(entityName, "update");

            const method: QueryMethod = {
              name: buildQueryName(entityName, "update"),
              kind: "update",
              params: [pkParam, bodyParam],
              returns: buildReturnType(entityName, false, true),
              callSignature: { style: "named", bodyStyle: "property" },
            };
            entityMethods.push(method);

            const updatableFields = entity.shapes.update.fields.filter(f => f.permissions.canUpdate);

            const templateParts: string[] = [`update ${tableName} set `];
            for (let i = 0; i < updatableFields.length; i++) {
              if (i === 0) {
                templateParts.push(`${updatableFields[i]!.columnName} = `);
              } else {
                templateParts.push(`, ${updatableFields[i]!.columnName} = `);
              }
            }
            templateParts.push(` where ${pkColumn} = `);
            templateParts.push(" returning *");

            const paramExprs: n.Expression[] = [
              ...updatableFields.map(f => b.memberExpression(b.identifier("data"), b.identifier(f.name))),
              b.identifier(pkField.name),
            ];
            const templateLiteral = buildTemplateLiteralWithParams(templateParts, paramExprs);

            const destructuredParam = buildDestructuredParam([pkParam, bodyParam]);
            const fnExpr = fn().rawParam(destructuredParam).arrow().body(
              conjure.stmt.return(templateLiteral),
            ).build();

            symbols.push({
              name: method.name,
              capability: `queries:sql:${entityName}:update`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: [
                {
                  from: queriesFilePath,
                  types: [entityName],
                },
              ],
              fileHeader: queryHeader,
            });
          }

          if (
            entity.kind === "table" &&
            entity.permissions.canDelete &&
            entity.primaryKey &&
            entity.primaryKey.columns.length > 0
          ) {
            const pkColumn = entity.primaryKey.columns[0]!;
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn)!;
            const pkParam = buildPkParam(pkField);

            const method: QueryMethod = {
              name: buildQueryName(entityName, "delete"),
              kind: "delete",
              params: [pkParam],
              returns: buildReturnType(entityName, false, false),
              callSignature: { style: "named" },
            };
            entityMethods.push(method);

            const templateLiteral = buildTemplateLiteral([
              `delete from ${tableName} where ${pkColumn} = `,
              "",
            ]);

            const destructuredParam = buildDestructuredParam([pkParam]);
            const fnExpr = fn().rawParam(destructuredParam).arrow().body(
              conjure.stmt.return(templateLiteral),
            ).build();

            symbols.push({
              name: method.name,
              capability: `queries:sql:${entityName}:delete`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              fileHeader: queryHeader,
            });
          }

          if (entity.permissions.canSelect) {
            const pkColumns = new Set(entity.primaryKey?.columns ?? []);
            const processedColumns = new Set<string>();
            for (const index of entity.indexes) {
              if (index.isPartial || index.hasExpressions || index.columns.length !== 1) continue;
              if (index.method === "gin" || index.method === "gist") continue;

              const columnName = index.columns[0]!;
              if (pkColumns.has(columnName)) continue;
              if (processedColumns.has(columnName)) continue;
              processedColumns.add(columnName);

              const field = entity.shapes.row.fields.find(f => f.columnName === columnName);
              if (!field) continue;

              const pascalColumn = columnName
                .split("_")
                .map(s => s.charAt(0).toUpperCase() + s.slice(1))
                .join("");
              const isUnique = index.isUnique;
              const lookupParam = buildLookupParam(field);

              const method: QueryMethod = {
                name: buildFindByQueryName(entityName, columnName),
                kind: "lookup",
                params: [lookupParam],
                returns: buildReturnType(entityName, !isUnique, isUnique),
                lookupField: field.name,
                isUniqueLookup: isUnique,
                callSignature: { style: "named" },
              };
              entityMethods.push(method);

              const templateLiteral = buildTemplateLiteral([
                `${selectClause} ${fromClause} where ${columnName} = `,
                "",
              ]);

              const destructuredParam = buildDestructuredParam([lookupParam]);
              const fnExpr = fn().rawParam(destructuredParam).arrow().body(
                conjure.stmt.return(templateLiteral),
              ).build();

              symbols.push({
                name: method.name,
                capability: `queries:sql:${entityName}:findBy${pascalColumn}`,
                node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
                exports: "named",
                fileHeader: queryHeader,
              });
            }
          }

          const pkField = entity.primaryKey?.columns[0]
            ? entity.shapes.row.fields.find(f => f.columnName === entity.primaryKey!.columns[0])
            : undefined;

          const entityExtension: EntityQueriesExtension = {
            methods: entityMethods,
            pkType: pkField ? pgTypeToTsType(getPgType(pkField)) : undefined,
            hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
          };

          symbols.push({
            name: `${entityName}Queries`,
            capability: `queries:sql:${entityName}`,
            node: b.emptyStatement(),
            metadata: entityExtension,
            exports: false,
          });
        }
      }

      return symbols;
    }),
  };
}
