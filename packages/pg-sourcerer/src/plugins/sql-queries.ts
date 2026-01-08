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

/**
 * SQL query style:
 * - "tag" (default): Tagged template literals (e.g., postgres.js, @effect/sql)
 *   Generates: sql<Type[]>`select * from users where id = ${id}`
 * - "string": Parameterized query strings (e.g., pg, mysql2, better-sqlite3)
 *   Generates: pool.query<Type[]>("select * from users where id = $1", [id])
 */
type SqlStyle = "tag" | "string";

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
// AST Building Helpers
// ============================================================================

/** Build SQL template literal expression (for tag style) */
const buildSqlTemplate = (
  parts: readonly string[],
  exprs: readonly n.Expression[],
): n.TemplateLiteral =>
  b.templateLiteral(
    parts.map((raw, i) => b.templateElement({ raw, cooked: raw }, i === parts.length - 1)),
    exprs.map(toExpr),
  );

/** Build await expression for sql tagged template with optional type parameter (tag style) */
const buildAwaitSqlTag = (
  sqlTemplate: n.TemplateLiteral,
  typeParam?: n.TSType,
): n.AwaitExpression => {
  const sqlId = b.identifier("sql");
  // If type parameter provided, wrap in TSInstantiationExpression: sql<Type>
  const tag = typeParam
    ? b.tsInstantiationExpression(sqlId, b.tsTypeParameterInstantiation([toTSType(typeParam)]))
    : sqlId;
  return b.awaitExpression(b.taggedTemplateExpression(tag, sqlTemplate));
};

/**
 * Build await expression for pool.query() with parameterized query (string style)
 * 
 * Generates: await pool.query<Type>('SELECT ... WHERE id = $1', [id])
 */
const buildAwaitSqlString = (
  sqlText: string,
  params: readonly n.Expression[],
  typeParam?: n.TSType,
): n.AwaitExpression => {
  const poolQuery = b.memberExpression(b.identifier("pool"), b.identifier("query"));
  
  // Add type parameter if provided: pool.query<Type>
  const callee = typeParam
    ? b.tsInstantiationExpression(poolQuery, b.tsTypeParameterInstantiation([toTSType(typeParam)]))
    : poolQuery;
  
  // Build arguments: ('sql text', [param1, param2])
  const args: n.Expression[] = [b.stringLiteral(sqlText)];
  if (params.length > 0) {
    args.push(b.arrayExpression(params.map(toExpr)));
  }
  
  return b.awaitExpression(b.callExpression(callee, args.map(toExpr)));
};

/**
 * Unified query builder that delegates to style-specific implementation.
 * 
 * For tag style: uses template literals with interpolated values
 * For string style: uses parameterized queries with $1, $2, ... placeholders
 */
interface QueryParts {
  /** SQL template parts (for tag) or joined with $N placeholders (for string) */
  readonly templateParts: readonly string[];
  /** Parameter expressions to interpolate */
  readonly params: readonly n.Expression[];
}

const buildQuery = (
  sqlStyle: SqlStyle,
  parts: QueryParts,
  typeParam?: n.TSType,
): n.AwaitExpression => {
  if (sqlStyle === "tag") {
    const template = buildSqlTemplate(parts.templateParts, parts.params);
    return buildAwaitSqlTag(template, typeParam);
  } else {
    // For string style, join template parts with $1, $2, ... placeholders
    const sqlText = parts.templateParts
      .map((part, i) => (i === 0 ? part : `$${i}${part}`))
      .join("");
    return buildAwaitSqlString(sqlText, parts.params, typeParam);
  }
};

/**
 * Build a variable declaration that extracts the first row from query result.
 * 
 * tag style: const [result] = await sql<Type[]>`...`
 * string style: const { rows: [result] } = await pool.query<Type>(...)
 */
const buildFirstRowDecl = (
  sqlStyle: SqlStyle,
  varName: string,
  queryExpr: n.AwaitExpression,
): n.VariableDeclaration => {
  if (sqlStyle === "tag") {
    // const [result] = await sql`...`
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.arrayPattern([b.identifier(varName)]), queryExpr),
    ]);
  } else {
    // const { rows: [result] } = await pool.query(...)
    const rowsProp = b.objectProperty(
      b.identifier("rows"),
      b.arrayPattern([b.identifier(varName)]),
    );
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.objectPattern([rowsProp]), queryExpr),
    ]);
  }
};

/**
 * Build a variable declaration that gets all rows from query result.
 * 
 * tag style: const result = await sql<Type[]>`...`  (returns array directly)
 * string style: const { rows: result } = await pool.query<Type>(...)
 */
const buildAllRowsDecl = (
  sqlStyle: SqlStyle,
  varName: string,
  queryExpr: n.AwaitExpression,
): n.VariableDeclaration => {
  if (sqlStyle === "tag") {
    // tag style returns array directly
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.identifier(varName), queryExpr),
    ]);
  } else {
    // string style: const { rows } = await pool.query(...)
    const rowsProp = b.objectProperty(b.identifier("rows"), b.identifier(varName));
    rowsProp.shorthand = varName === "rows";
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.objectPattern([rowsProp]), queryExpr),
    ]);
  }
};

/**
 * Build a return statement that returns query results.
 * 
 * tag style: return await sql<Type[]>`...`  (returns array directly)
 * string style: extracts .rows and returns
 */
const buildReturnQuery = (
  sqlStyle: SqlStyle,
  parts: QueryParts,
  typeParam: n.TSType,
): n.Statement[] => {
  const queryExpr = buildQuery(sqlStyle, parts, typeParam);
  
  if (sqlStyle === "tag") {
    // tag style returns array directly
    return [b.returnStatement(queryExpr)];
  } else {
    // string style: const { rows } = await pool.query(...); return rows
    const decl = buildAllRowsDecl(sqlStyle, "rows", queryExpr);
    return [decl, b.returnStatement(b.identifier("rows"))];
  }
};

/** Create a typed parameter identifier */
const typedParam = (name: string, type: n.TSType): n.Identifier => {
  const param = b.identifier(name);
  param.typeAnnotation = b.tsTypeAnnotation(toTSType(type));
  return param;
};

/** Create a destructured parameter with Pick type: { field }: Pick<Entity, 'field'> */
const pickParam = (
  fields: readonly string[],
  entityType: string,
): n.ObjectPattern => {
  const pattern = b.objectPattern(fields.map(f => {
    const prop = b.objectProperty(b.identifier(f), b.identifier(f));
    prop.shorthand = true;
    return prop;
  }));
  // Pick<Entity, 'field1' | 'field2'>
  const pickType = ts.ref("Pick", [
    ts.ref(entityType),
    fields.length === 1
      ? ts.literal(fields[0]!)
      : ts.union(...fields.map(f => ts.literal(f))),
  ]);
  pattern.typeAnnotation = b.tsTypeAnnotation(toTSType(pickType));
  return pattern;
};

interface DestructuredField {
  readonly name: string;
  readonly type: n.TSType;
  readonly optional?: boolean;
  readonly defaultValue?: n.Expression;
}

/** Create a destructured parameter with explicit types and optional defaults */
const destructuredParam = (fields: readonly DestructuredField[]): n.ObjectPattern => {
  const pattern = b.objectPattern(fields.map(f => {
    const id = b.identifier(f.name);
    // Use AssignmentPattern for default values: { limit = 50 }
    const value = f.defaultValue
      ? b.assignmentPattern(id, toExpr(f.defaultValue))
      : id;
    const prop = b.objectProperty(b.identifier(f.name), value);
    prop.shorthand = true;
    return prop;
  }));
  // Build the type annotation: { name: type; name?: type; }
  const typeAnnotation = ts.objectType(
    fields.map(f => ({ name: f.name, type: f.type, optional: f.optional })),
  );
  pattern.typeAnnotation = b.tsTypeAnnotation(toTSType(typeAnnotation));
  return pattern;
};

/** Create an async function declaration (return type inferred) */
const asyncFn = (
  name: string,
  params: (n.Identifier | n.ObjectPattern)[],
  body: n.Statement[],
): n.FunctionDeclaration => {
  const fn = b.functionDeclaration(b.identifier(name), params, b.blockStatement(body.map(toStmt)));
  fn.async = true;
  return fn;
};

/** Export a function declaration */
const exportFn = (fn: n.FunctionDeclaration): n.Statement =>
  b.exportNamedDeclaration(fn, []) as n.Statement;

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
  const queryExpr = buildQuery(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = buildFirstRowDecl(sqlStyle, "result", queryExpr);

  return exportFn(
    asyncFn(`find${entity.name}ById`, [pickParam([fieldName], rowType)], [
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

  return exportFn(
    asyncFn(
      `findMany${entity.name}s`,
      [
        destructuredParam([
          { name: "limit", type: ts.number(), optional: true, defaultValue: b.numericLiteral(50) },
          { name: "offset", type: ts.number(), optional: true, defaultValue: b.numericLiteral(0) },
        ]),
      ],
      buildReturnQuery(sqlStyle, parts, ts.array(ts.ref(rowType))),
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
  const queryExpr = buildQuery(sqlStyle, parts);
  return exportFn(
    asyncFn(`delete${entity.name}`, [pickParam([fieldName], rowType)], [
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

  const queryExpr = buildQuery(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = buildFirstRowDecl(sqlStyle, "result", queryExpr);

  // Simple typed parameter: data: InsertType
  const param = typedParam("data", ts.ref(insertType));

  return exportFn(
    asyncFn(`insert${entity.name}`, [param], [varDecl, b.returnStatement(b.identifier("result"))]),
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
    const queryExpr = buildQuery(sqlStyle, parts, ts.array(ts.ref(rowType)));
    const varDecl = buildFirstRowDecl(sqlStyle, "result", queryExpr);

    return exportFn(
      asyncFn(fnName, [pickParam([fieldName], rowType)], [
        varDecl,
        b.returnStatement(b.identifier("result")),
      ]),
    );
  }

  // Non-unique: return all matching rows
  return exportFn(
    asyncFn(fnName, [pickParam([fieldName], rowType)], buildReturnQuery(sqlStyle, parts, ts.array(ts.ref(rowType)))),
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
