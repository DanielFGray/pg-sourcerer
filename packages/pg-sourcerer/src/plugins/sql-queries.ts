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
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js";

const { ts, b, stmt } = conjure;
const { toExpr, toTSType, toStmt } = cast;

// ============================================================================
// Configuration
// ============================================================================

const SqlQueriesPluginConfig = S.Struct({
  outputDir: S.String,
  header: S.optional(S.String),
});

type SqlQueriesPluginConfig = S.Schema.Type<typeof SqlQueriesPluginConfig>;

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
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
// AST Building Helpers
// ============================================================================

/** Build SQL template literal expression */
const buildSqlTemplate = (
  parts: readonly string[],
  exprs: readonly n.Expression[],
): n.TemplateLiteral =>
  b.templateLiteral(
    parts.map((raw, i) => b.templateElement({ raw, cooked: raw }, i === parts.length - 1)),
    exprs.map(toExpr),
  );

/** Build await expression for sql tagged template */
const buildAwaitSql = (sqlTemplate: n.TemplateLiteral): n.AwaitExpression =>
  b.awaitExpression(b.taggedTemplateExpression(b.identifier("sql"), sqlTemplate));

/** Create a typed parameter identifier */
const typedParam = (name: string, type: n.TSType): n.Identifier => {
  const param = b.identifier(name);
  param.typeAnnotation = b.tsTypeAnnotation(toTSType(type));
  return param;
};

/** Create an async function declaration with return type */
const asyncFn = (
  name: string,
  params: n.Identifier[],
  body: n.Statement[],
  returnType: n.TSType,
): n.FunctionDeclaration => {
  const fn = b.functionDeclaration(b.identifier(name), params, b.blockStatement(body.map(toStmt)));
  fn.async = true;
  fn.returnType = b.tsTypeAnnotation(toTSType(returnType));
  return fn;
};

/** Export a function declaration */
const exportFn = (fn: n.FunctionDeclaration): n.Statement =>
  b.exportNamedDeclaration(fn, []) as n.Statement;

// ============================================================================
// CRUD Function Generators
// ============================================================================

/** Generate findById function if entity has a primary key */
const generateFindById = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity } = ctx;
  if (!entity.primaryKey) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldType = getFieldTypeAst(pkField, ctx);
  const paramType = ts.objectType([{ name: "id", type: fieldType }]);

  const sqlTemplate = buildSqlTemplate(
    [`select * from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    [b.memberExpression(b.identifier("args"), b.identifier("id"), false)],
  );

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.arrayPattern([b.identifier("result")]), buildAwaitSql(sqlTemplate)),
  ]);

  return exportFn(
    asyncFn(
      `find${entity.name}ById`,
      [typedParam("args", paramType)],
      [varDecl, b.returnStatement(b.identifier("result"))],
      ts.promise(ts.union(ts.ref(rowType), ts.null())),
    ),
  );
};

/** Generate findMany function with pagination */
const generateFindMany = (ctx: GenerationContext): n.Statement => {
  const { entity } = ctx;
  const rowType = entity.shapes.row.name;

  const paramType = ts.objectType([
    { name: "limit", type: ts.number(), optional: true },
    { name: "offset", type: ts.number(), optional: true },
  ]);

  const sqlTemplate = buildSqlTemplate(
    [`select * from ${entity.schemaName}.${entity.pgName} limit `, ` offset `, ""],
    [b.identifier("limit"), b.identifier("offset")],
  );

  return exportFn(
    asyncFn(
      `findMany${entity.name}s`,
      [typedParam("args", paramType)],
      [
        stmt.const(
          "limit",
          b.logicalExpression(
            "??",
            b.memberExpression(b.identifier("args"), b.identifier("limit"), false),
            b.numericLiteral(50),
          ),
        ),
        stmt.const(
          "offset",
          b.logicalExpression(
            "??",
            b.memberExpression(b.identifier("args"), b.identifier("offset"), false),
            b.numericLiteral(0),
          ),
        ),
        b.returnStatement(buildAwaitSql(sqlTemplate)),
      ],
      ts.promise(ts.array(ts.ref(rowType))),
    ),
  );
};

/** Generate delete function if entity has a primary key */
const generateDelete = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity } = ctx;
  if (!entity.primaryKey) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const fieldType = getFieldTypeAst(pkField, ctx);
  const paramType = ts.objectType([{ name: "id", type: fieldType }]);

  const sqlTemplate = buildSqlTemplate(
    [`delete from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    [b.memberExpression(b.identifier("args"), b.identifier("id"), false)],
  );

  return exportFn(
    asyncFn(
      `delete${entity.name}`,
      [typedParam("args", paramType)],
      [b.expressionStatement(buildAwaitSql(sqlTemplate))],
      ts.promise(ts.void()),
    ),
  );
};

/** Generate all CRUD functions for an entity */
const generateCrudFunctions = (ctx: GenerationContext): readonly n.Statement[] =>
  [generateFindById(ctx), generateFindMany(ctx), generateDelete(ctx)].filter(
    (s): s is n.Statement => s != null,
  );

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
  const { entity } = ctx;
  const rowType = entity.shapes.row.name;
  const columnName = index.columnNames[0]!;
  const paramName = index.columns[0]!;
  const field = findRowField(entity, paramName);
  const fieldType = getFieldTypeAst(field, ctx);
  const paramType = ts.objectType([{ name: paramName, type: fieldType }]);
  const isUnique = index.isUnique || index.isPrimary;

  const sqlTemplate = buildSqlTemplate(
    [`select * from ${entity.schemaName}.${entity.pgName} where ${columnName} = `, ""],
    [b.memberExpression(b.identifier("args"), b.identifier(paramName), false)],
  );

  const fnName = generateLookupName(entity, index);

  if (isUnique) {
    const varDecl = b.variableDeclaration("const", [
      b.variableDeclarator(b.arrayPattern([b.identifier("result")]), buildAwaitSql(sqlTemplate)),
    ]);

    return exportFn(
      asyncFn(
        fnName,
        [typedParam("args", paramType)],
        [varDecl, b.returnStatement(b.identifier("result"))],
        ts.promise(ts.union(ts.ref(rowType), ts.null())),
      ),
    );
  }

  return exportFn(
    asyncFn(
      fnName,
      [typedParam("args", paramType)],
      [b.returnStatement(buildAwaitSql(sqlTemplate))],
      ts.promise(ts.array(ts.ref(rowType))),
    ),
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

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const genCtx: GenerationContext = { entity, enums, ir: ctx.ir };
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

        ctx
          .file(filePath)
          .header(
            config.header ? `${config.header}\n` : "// This file is auto-generated. Do not edit.\n",
          )
          .import({ kind: "relative", names: ["sql"], from: "../db" })
          .import({
            kind: "symbol",
            ref: { capability: "types", entity: entity.name, shape: "row" },
          })
          .ast(conjure.program(...statements))
          .emit();
      });
  },
});
