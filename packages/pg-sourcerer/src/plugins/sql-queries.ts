/**
 * SQL Queries Plugin - Generate raw SQL query functions using template strings
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import type { FileNameContext } from "../services/plugin.js";
import type { Field, IndexDef, TableEntity, EnumEntity, SemanticIR } from "../ir/semantic-ir.js";
import { getTableEntities, getEnumEntities } from "../ir/semantic-ir.js";
import { conjure, cast } from "../lib/conjure.js";
import { hex, type SqlStyle, type QueryParts } from "../lib/hex.js";
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js";

const { ts, b, param } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const SqlQueriesPluginConfig = S.Struct({
  outputDir: S.String,
  header: S.optional(S.String),
  /** SQL query style. Defaults to "tag" (tagged template literals) */
  sqlStyle: S.optional(S.Union(S.Literal("tag"), S.Literal("string"))),
});

type SqlQueriesPluginConfig = S.Schema.Type<typeof SqlQueriesPluginConfig>;

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
  readonly sqlStyle: SqlStyle;
}

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName);

/** Get the TypeScript type AST for a field */
const getFieldTypeAst = (field: Field | undefined, ctx: GenerationContext): n.TSType => {
  if (!field) return ts.string();
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? ts.ref(resolved.enumDef.name) : tsTypeToAst(resolved.tsType);
};

// ============================================================================
// CRUD Function Generators
// ============================================================================

/** Generate findById function if entity has a primary key and canSelect permission */
const generateFindById = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldName = pkField.name; // JS property name (e.g., "id")

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    params: [b.identifier(fieldName)],
  };

  // Build query and extract first row
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  return hex.exportFn(
    hex.asyncFn(`find${entity.name}ById`, [param.pick([fieldName], rowType)], [
      varDecl,
      b.returnStatement(b.identifier("result")),
    ]),
  );
};

/** Generate findMany function with pagination if entity has canSelect permission */
const generateFindMany = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.permissions.canSelect) return undefined;

  const rowType = entity.shapes.row.name;

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} limit `, ` offset `, ""],
    params: [b.identifier("limit"), b.identifier("offset")],
  };

  return hex.exportFn(
    hex.asyncFn(
      `findMany${entity.name}s`,
      [
        param.destructured([
          { name: "limit", type: ts.number(), optional: true, defaultValue: b.numericLiteral(50) },
          { name: "offset", type: ts.number(), optional: true, defaultValue: b.numericLiteral(0) },
        ]),
      ],
      hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType))),
    ),
  );
};

/** Generate delete function if entity has a primary key and canDelete permission */
const generateDelete = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldName = pkField.name;

  const parts: QueryParts = {
    templateParts: [`delete from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    params: [b.identifier(fieldName)],
  };

  // Delete returns void, no type parameter needed
  const queryExpr = hex.query(sqlStyle, parts);
  return hex.exportFn(
    hex.asyncFn(`delete${entity.name}`, [param.pick([fieldName], rowType)], [
      b.expressionStatement(queryExpr),
    ]),
  );
};

/** Generate insert function if entity has canInsert permission */
const generateInsert = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.permissions.canInsert) return undefined;

  // Use insert shape if available, otherwise fall back to row
  const insertShape = entity.shapes.insert ?? entity.shapes.row;
  const rowType = entity.shapes.row.name;
  const insertType = insertShape.name;

  // Build column list and values from insertable fields
  const insertableFields = insertShape.fields.filter(f => f.permissions.canInsert);
  if (insertableFields.length === 0) return undefined;

  const columnNames = insertableFields.map(f => f.columnName);
  const fieldNames = insertableFields.map(f => f.name);

  // Build: insert into schema.table (col1, col2) values ($data.field1, $data.field2) returning *
  const columnList = columnNames.join(", ");
  const valuePlaceholders = fieldNames.map((_, i) => (i === 0 ? "" : ", "));
  
  // Template parts: "insert into ... values (" + "" + ", " + ", " + ... + ") returning *"
  const parts: QueryParts = {
    templateParts: [
      `insert into ${entity.schemaName}.${entity.pgName} (${columnList}) values (`,
      ...valuePlaceholders.slice(1),
      `) returning *`,
    ],
    params: fieldNames.map(f => b.memberExpression(b.identifier("data"), b.identifier(f), false)),
  };

  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  // Simple typed parameter: data: InsertType
  const dataParam = param.typed("data", ts.ref(insertType));

  return hex.exportFn(
    hex.asyncFn(`insert${entity.name}`, [dataParam], [varDecl, b.returnStatement(b.identifier("result"))]),
  );
};

/** Generate all CRUD functions for an entity */
const generateCrudFunctions = (ctx: GenerationContext): readonly n.Statement[] =>
  [
    generateFindById(ctx),
    generateFindMany(ctx),
    generateInsert(ctx),
    generateDelete(ctx),
  ].filter((s): s is n.Statement => s != null);

// ============================================================================
// Index-based Lookup Functions
// ============================================================================

/** Check if an index should generate a lookup function */
const shouldGenerateLookup = (index: IndexDef): boolean =>
  !index.isPartial &&
  !index.hasExpressions &&
  index.columns.length === 1 &&
  index.method !== "gin" &&
  index.method !== "gist";

/** Generate a function name for an index-based lookup */
const generateLookupName = (entity: TableEntity, index: IndexDef): string => {
  const entitySingular = entity.name.replace(/s$/, "");
  const byPart = index.columns
    .map(col => `By${col.charAt(0).toUpperCase() + col.slice(1)}`)
    .join("");
  return `get${entitySingular}${byPart}`;
};

/** Generate a lookup function for a single-column index */
const generateLookupFunction = (index: IndexDef, ctx: GenerationContext): n.Statement => {
  const { entity, sqlStyle } = ctx;
  const rowType = entity.shapes.row.name;
  const columnName = index.columnNames[0]!;
  const field = findRowField(entity, columnName);
  const fieldName = field?.name ?? index.columns[0]!;
  const isUnique = index.isUnique || index.isPrimary;

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} where ${columnName} = `, ""],
    params: [b.identifier(fieldName)],
  };

  const fnName = generateLookupName(entity, index);

  if (isUnique) {
    // Extract first row for unique lookups
    const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
    const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

    return hex.exportFn(
      hex.asyncFn(fnName, [param.pick([fieldName], rowType)], [
        varDecl,
        b.returnStatement(b.identifier("result")),
      ]),
    );
  }

  // Non-unique: return all matching rows
  return hex.exportFn(
    hex.asyncFn(fnName, [param.pick([fieldName], rowType)], hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType)))),
  );
};

/** Generate lookup functions for all eligible indexes, deduplicating by name */
const generateLookupFunctions = (ctx: GenerationContext): readonly n.Statement[] => {
  const seen = new Set<string>();

  return ctx.entity.indexes
    .filter(index => shouldGenerateLookup(index) && !index.isPrimary)
    .filter(index => {
      const name = generateLookupName(ctx.entity, index);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map(index => generateLookupFunction(index, ctx));
};

// ============================================================================
// Plugin Definition
// ============================================================================

export const sqlQueriesPlugin = definePlugin({
  name: "sql-queries",
  provides: ["queries", "queries:sql"],
  requires: ["types"],
  configSchema: SqlQueriesPluginConfig,
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enums = getEnumEntities(ctx.ir);
    const sqlStyle: SqlStyle = config.sqlStyle ?? "tag";

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const genCtx: GenerationContext = { entity, enums, ir: ctx.ir, sqlStyle };
        const statements = [...generateCrudFunctions(genCtx), ...generateLookupFunctions(genCtx)];

        if (statements.length === 0) return;

        const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags);
        const fileNameCtx: FileNameContext = {
          entityName,
          pgName: entity.pgName,
          schema: entity.schemaName,
          inflection: ctx.inflection,
          entity,
        };
        const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`;

        const file = ctx
          .file(filePath)
          .header(
            config.header ? `${config.header}\n` : "// This file is auto-generated. Do not edit.\n",
          );

        // Import the appropriate SQL client based on style
        if (sqlStyle === "tag") {
          file.import({ kind: "relative", names: ["sql"], from: "../db" });
        } else {
          file.import({ kind: "relative", names: ["pool"], from: "../db" });
        }

        file.import({
          kind: "symbol",
          ref: { capability: "types", entity: entity.name, shape: "row" },
        });

        // Import insert type if insert function is generated
        if (entity.permissions.canInsert) {
          const insertShape = entity.shapes.insert ?? entity.shapes.row;
          // Only import if it's a different type than row
          if (insertShape !== entity.shapes.row) {
            file.import({
              kind: "symbol",
              ref: { capability: "types", entity: entity.name, shape: "insert" },
            });
          }
        }

        file.ast(conjure.program(...statements)).emit();
      });
  },
});
