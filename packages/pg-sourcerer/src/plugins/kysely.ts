/**
 * Kysely Plugin - Generate Kysely-compatible types and query functions
 *
 * Consolidates types and queries generation into a single plugin with unified config.
 * Generates:
 * - Types: DB interface, table interfaces with Generated<T> wrappers, enum types
 * - Queries: CRUD functions, index lookups, stored function wrappers
 *
 * @example
 * ```typescript
 * import { kysely } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     kysely({
 *       outputDir: "db",
 *       generateQueries: true,
 *     }),
 *   ],
 * })
 * ```
 */
import { Array as Arr, Option, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { findEnumByPgName, findCompositeByPgName, PgTypeOid } from "../services/pg-types.js";
import type {
  Field,
  TableEntity,
  EnumEntity,
  CompositeEntity,
  ExtensionInfo,
  SemanticIR,
} from "../ir/semantic-ir.js";
import {
  getEnumEntities,
  getTableEntities,
  getCompositeEntities,
  getFunctionEntities,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js";
import { inflect } from "../services/inflection.js";
import type { TypeHintRegistry, TypeHintFieldMatch } from "../services/type-hints.js";
import { isEnumType, getPgTypeName } from "../lib/field-utils.js";
import { getExtensionTypeMapping } from "../services/pg-types.js";
import type { ParamSource, CallSignature } from "../ir/extensions/queries.js";

const { ts, exp, b, param, str } = conjure;
const { toExpr } = cast;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the kysely plugin
 */
export interface KyselyConfig {
  /** Output directory for generated files */
  readonly outputDir?: string;
  /** DB interface type name */
  readonly dbTypeName?: string;
  /** Use camelCase for field names (true) or keep original (false) */
  readonly camelCase?: boolean;
  /** Use runtime enums instead of string literal unions */
  readonly runtimeEnums?: boolean;
  /** Use type-only imports (recommended) */
  readonly typeOnlyImports?: boolean;
  /** Whether to generate query functions (default: true) */
  readonly generateQueries?: boolean;
  /**
   * Path to import DB type from (relative to query files).
   * Defaults to "./${dbTypeName}.js" since both are in the same outputDir.
   */
  readonly dbTypesPath?: string;
  /**
   * Whether to call .execute() / .executeTakeFirst() on queries.
   * When true (default), methods return Promise<Row> or Promise<Row[]>.
   */
  readonly executeQueries?: boolean;
  /**
   * Whether to generate listMany() method for unfiltered table scans.
   * Disabled by default since unfiltered scans don't use indexes.
   */
  readonly generateListMany?: boolean;
  /** Whether to generate function wrappers for stored functions. */
  readonly generateFunctions?: boolean;
  /** Output file name for scalar function wrappers (relative to outputDir). */
  readonly functionsFile?: string;
  /**
   * Custom export name function for CRUD/lookup methods.
   * @default (_entityName, methodName) => camelCase(methodName)
   */
  readonly exportName?: ExportNameFn;
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export const findById = ...`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   */
  readonly exportStyle?: "flat" | "namespace";
  /**
   * Use explicit column lists instead of .selectAll().
   * When true, generates .select(['col1', 'col2']) which excludes omitted fields at runtime.
   */
  readonly explicitColumns?: boolean;
  /**
   * Whether to pass db as first parameter to each function.
   * When true (default), functions take `db: Kysely<DB>` as first arg.
   */
  readonly dbAsParameter?: boolean;
  /**
   * Header content to prepend to each generated query file.
   * Use this to provide imports when dbAsParameter is false.
   */
  readonly header?: string;
  /** Default limit for listMany queries. */
  readonly defaultLimit?: number;
}

const KyselyConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "db" }),
  dbTypeName: S.optionalWith(S.String, { default: () => "DB" }),
  camelCase: S.optionalWith(S.Boolean, { default: () => true }),
  runtimeEnums: S.optionalWith(S.Boolean, { default: () => false }),
  typeOnlyImports: S.optionalWith(S.Boolean, { default: () => true }),
  generateQueries: S.optionalWith(S.Boolean, { default: () => true }),
  dbTypesPath: S.optionalWith(S.String, { default: () => "./db.js" }),
  executeQueries: S.optionalWith(S.Boolean, { default: () => true }),
  generateListMany: S.optionalWith(S.Boolean, { default: () => false }),
  generateFunctions: S.optionalWith(S.Boolean, { default: () => true }),
  functionsFile: S.optionalWith(S.String, { default: () => "functions.ts" }),
  exportName: S.optional(S.Any),
  exportStyle: S.optionalWith(S.Literal("flat", "namespace"), { default: () => "flat" as const }),
  explicitColumns: S.optionalWith(S.Boolean, { default: () => true }),
  dbAsParameter: S.optionalWith(S.Boolean, { default: () => true }),
  header: S.optional(S.String),
  defaultLimit: S.optionalWith(S.Number, { default: () => 50 }),
});

/**
 * Function to generate export names for CRUD/lookup methods.
 */
type ExportNameFn = (entityName: string, methodName: string) => string;

// ============================================================================
// Types from kysely-types.ts
// ============================================================================

interface FieldContext {
  readonly schemaName: string;
  readonly tableName: string;
  readonly enums: readonly EnumEntity[];
  readonly composites: readonly CompositeEntity[];
  readonly extensions: readonly ExtensionInfo[];
  readonly typeHints: TypeHintRegistry;
  readonly defaultSchemas: readonly string[];
}

interface KyselyType {
  readonly selectType: n.TSType;
  readonly insertType?: n.TSType;
  readonly updateType?: n.TSType;
  readonly needsColumnType: boolean;
  readonly externalImport?: { name: string; from: string };
}

const GENERATED_TYPE_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>`;

const ARRAY_TYPE_DEF = `ArrayTypeImpl<T> extends (infer U)[]
  ? U[]
  : ArrayTypeImpl<T>`;

const ARRAY_TYPE_IMPL_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S[], I[], U[]>
  : T[]`;

const SCALAR_TYPES: Record<string, () => n.TSType> = {
  bool: ts.boolean,
  int2: ts.number,
  int4: ts.number,
  float4: ts.number,
  float8: ts.number,
  oid: ts.number,
  text: ts.string,
  varchar: ts.string,
  bpchar: ts.string,
  char: ts.string,
  name: ts.string,
  bit: ts.string,
  varbit: ts.string,
  xml: ts.string,
  uuid: ts.string,
  inet: ts.string,
  cidr: ts.string,
  macaddr: ts.string,
  macaddr8: ts.string,
  line: ts.string,
  lseg: ts.string,
  box: ts.string,
  path: ts.string,
  polygon: ts.string,
  time: ts.string,
  timetz: ts.string,
  tsvector: ts.string,
  tsquery: ts.string,
  txid_snapshot: ts.string,
  money: ts.string,
  bytea: () => ts.ref("Buffer"),
};

interface ComplexTypeMapping {
  readonly select: () => n.TSType;
  readonly insert: () => n.TSType;
  readonly update: () => n.TSType;
  readonly import?: { name: string; from: string };
}

const COMPLEX_TYPES: Record<string, ComplexTypeMapping> = {
  int8: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number(), ts.bigint()),
    update: () => ts.union(ts.string(), ts.number(), ts.bigint()),
  },
  numeric: {
    select: ts.string,
    insert: () => ts.union(ts.number(), ts.string()),
    update: () => ts.union(ts.number(), ts.string()),
  },
  date: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },
  timestamp: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },
  timestamptz: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },
  interval: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number()),
    update: () => ts.union(ts.string(), ts.number()),
  },
  json: {
    select: () => ts.ref("JsonValue"),
    insert: () => ts.ref("JsonValue"),
    update: () => ts.ref("JsonValue"),
  },
  jsonb: {
    select: () => ts.ref("JsonValue"),
    insert: () => ts.ref("JsonValue"),
    update: () => ts.ref("JsonValue"),
  },
  point: {
    select: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
    ]),
    insert: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
    ]),
    update: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
    ]),
  },
  circle: {
    select: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
      { name: "radius", type: ts.number() },
    ]),
    insert: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
      { name: "radius", type: ts.number() },
    ]),
    update: () => ts.objectType([
      { name: "x", type: ts.number() },
      { name: "y", type: ts.number() },
      { name: "radius", type: ts.number() },
    ]),
  },
};

// ============================================================================
// Queries types from kysely-queries.ts
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
  readonly defaultSchemas: readonly string[];
  readonly dbTypesPath: string;
  readonly executeQueries: boolean;
  readonly generateListMany: boolean;
  readonly entityName: string;
  readonly exportName: ExportNameFn;
  readonly explicitColumns: boolean;
  readonly dbAsParameter: boolean;
  readonly defaultLimit: number;
}

interface MethodDef {
  readonly name: string;
  readonly fn: n.ArrowFunctionExpression;
  readonly meta: {
    readonly name: string;
    readonly kind: "read" | "list" | "create" | "update" | "delete" | "lookup" | "function";
    readonly params: ReadonlyArray<{
      name: string;
      type: string;
      required: boolean;
      columnName?: string;
      source?: ParamSource;
    }>;
    readonly returns: { type: string; nullable: boolean; isArray: boolean };
    readonly lookupField?: string;
    readonly isUniqueLookup?: boolean;
    readonly callSignature?: CallSignature;
  };
}

// ============================================================================
// Helper Functions (Types)
// ============================================================================

const buildFieldMatch = (field: Field, ctx: FieldContext): TypeHintFieldMatch => ({
  schema: ctx.schemaName,
  table: ctx.tableName,
  column: field.columnName,
  pgType: field.isArray && field.elementTypeName
    ? field.elementTypeName
    : field.pgAttribute.getType()?.typname ?? "",
});

function resolveFieldTypeForKysely(field: Field, ctx: FieldContext): KyselyType {
  const pgType = field.pgAttribute.getType();
  const typeName = pgType?.typname ?? "";

  const fieldMatch = buildFieldMatch(field, ctx);
  const tsTypeHint = ctx.typeHints.getHint<string>(fieldMatch, "tsType");

  if (Option.isSome(tsTypeHint)) {
    const typeName = tsTypeHint.value;
    const importPath = ctx.typeHints.getHint<string>(fieldMatch, "import");
    return {
      selectType: ts.ref(typeName),
      needsColumnType: false,
      externalImport: pipe(
        importPath,
        Option.map(path => ({ name: typeName, from: path })),
        Option.getOrUndefined
      ),
    };
  }

  if (isEnumType(field)) {
    const enumName = getPgTypeName(field);
    if (enumName) {
      const enumDef = findEnumByPgName(ctx.enums, enumName);
      if (Option.isSome(enumDef)) {
        return {
          selectType: ts.ref(enumDef.value.name),
          needsColumnType: false,
        };
      }
    }
  }

  if (pgType?.typtype === "c") {
    const compositeName = getPgTypeName(field);
    if (compositeName) {
      const compositeDef = findCompositeByPgName(ctx.composites, compositeName);
      if (Option.isSome(compositeDef)) {
        return {
          selectType: ts.ref(compositeDef.value.name),
          needsColumnType: false,
        };
      }
    }
  }

  const complexType = COMPLEX_TYPES[typeName];
  if (complexType) {
    return {
      selectType: complexType.select(),
      insertType: complexType.insert(),
      updateType: complexType.update(),
      needsColumnType: true,
      externalImport: complexType.import,
    };
  }

  const scalarBuilder = SCALAR_TYPES[typeName];
  if (scalarBuilder) {
    return {
      selectType: scalarBuilder(),
      needsColumnType: false,
    };
  }

  if (pgType) {
    const extType = getExtensionTypeMapping(
      typeName,
      String(pgType.typnamespace),
      ctx.extensions
    );
    if (Option.isSome(extType)) {
      return {
        selectType: ts.fromString(extType.value),
        needsColumnType: false,
      };
    }
  }

  return {
    selectType: ts.string(),
    needsColumnType: false,
  };
}

function buildFieldType(field: Field, kyselyType: KyselyType, needsGenerated: boolean): n.TSType {
  let baseType: n.TSType;

  if (kyselyType.needsColumnType && kyselyType.insertType && kyselyType.updateType) {
    baseType = ts.ref("ColumnType", [
      kyselyType.selectType,
      kyselyType.insertType,
      kyselyType.updateType,
    ]);
  } else {
    baseType = kyselyType.selectType;
  }

  if (field.isArray) {
    if (kyselyType.needsColumnType) {
      baseType = ts.ref("ArrayType", [baseType]);
    } else {
      baseType = ts.array(baseType);
    }
  }

  if (field.nullable) {
    baseType = ts.nullable(baseType);
  }

  if (needsGenerated) {
    baseType = ts.ref("Generated", [baseType]);
  }

  return baseType;
}

function isGeneratedField(field: Field): boolean {
  // Identity and generated columns are always "generated" regardless of hasDefault
  if (field.isIdentity) return true;
  if (field.isGenerated) return true;

  if (!field.hasDefault) return false;

  if (!field.permissions.canInsert) return true;

  const pgType = field.pgAttribute.getType();
  if (!pgType) return false;

  const typeOid = Number(pgType._id);
  const isIntegerType = typeOid === PgTypeOid.Int2
    || typeOid === PgTypeOid.Int4
    || typeOid === PgTypeOid.Int8;

  if (isIntegerType && field.hasDefault) {
    const constraints = field.pgAttribute.getClass()?.getConstraints() ?? [];
    const isPrimaryKey = constraints.some(
      c => c.contype === "p" && c.conkey?.includes(field.pgAttribute.attnum)
    );
    if (isPrimaryKey) return true;
  }

  return false;
}

// ============================================================================
// Helper Functions (Queries)
// ============================================================================

const getTableTypeName = (entity: TableEntity): string => entity.name;

const getTableRef = (entity: TableEntity, defaultSchemas: ReadonlyArray<string>): string =>
  defaultSchemas.includes(entity.schemaName)
    ? entity.pgName
    : `${entity.schemaName}.${entity.pgName}`;

const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName);

const getFieldTypeAst = (field: Field | undefined, ctx: GenerationContext): n.TSType => {
  if (!field) return ts.string();
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? ts.ref(resolved.enumDef.name) : tsTypeToAst(resolved.tsType);
};

const getFieldTypeString = (field: Field | undefined, ctx: GenerationContext): string => {
  if (!field) return "string";
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? resolved.enumDef.name : resolved.tsType;
};

const toPascalCase = (s: string): string => inflect.pascalCase(s);

const id = (name: string): n.Identifier => b.identifier(name);

const call = (obj: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  b.callExpression(b.memberExpression(toExpr(obj), id(method)), args.map(toExpr));

const selectFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "selectFrom", [str(tableRef)]);

const selectColumns = (base: n.Expression, entity: TableEntity, explicitColumns: boolean): n.CallExpression =>
  explicitColumns
    ? call(base, "select", [b.arrayExpression(entity.shapes.row.fields.map(f => str(f.columnName)))])
    : call(base, "selectAll");

const insertInto = (tableRef: string): n.CallExpression =>
  call(id("db"), "insertInto", [str(tableRef)]);

const updateTable = (tableRef: string): n.CallExpression =>
  call(id("db"), "updateTable", [str(tableRef)]);

const deleteFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "deleteFrom", [str(tableRef)]);

const chain = (expr: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  call(expr, method, args);

const arrowFn = (params: n.Expression[], body: n.Expression): n.ArrowFunctionExpression => {
  const fn = b.arrowFunctionExpression(
    params.map(p => p as any),
    toExpr(body),
  );
  return fn;
};

const pgTypeNameToTs = (typeName: string): string => {
  const baseName = typeName.includes(".") ? typeName.split(".").pop()! : typeName;

  switch (baseName) {
    case "bool":
    case "boolean":
      return "boolean";
    case "int2":
    case "smallint":
    case "int4":
    case "integer":
    case "int":
    case "oid":
    case "float4":
    case "real":
    case "float8":
    case "double precision":
      return "number";
    case "int8":
    case "bigint":
    case "numeric":
    case "decimal":
    case "money":
      return "string";
    case "text":
    case "varchar":
    case "character varying":
    case "char":
    case "character":
    case "bpchar":
    case "name":
    case "xml":
    case "bit":
    case "varbit":
    case "bit varying":
    case "uuid":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "time":
    case "timetz":
    case "time with time zone":
    case "time without time zone":
    case "interval":
      return "string";
    case "date":
    case "timestamp":
    case "timestamptz":
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "Date";
    case "json":
    case "jsonb":
    case "jsonpath":
      return "unknown";
    case "bytea":
      return "Buffer";
    case "void":
      return "void";
    default:
      return "unknown";
  }
};

// ============================================================================
// Query Method Generators
// ============================================================================

const generateFindById = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, explicitColumns, dbAsParameter } = ctx;
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);

  let query: n.Expression = chain(
    selectColumns(selectFrom(tableRef), entity, explicitColumns),
    "where",
    [str(pkColName), str("="), id(fieldName)],
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirst");
  }

  const optionsParam = param.destructured([{ name: fieldName, type: fieldType }]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "FindById");
  const rowType = entity.shapes.row.name;
  const meta = {
    name,
    kind: "read" as const,
    params: [{
      name: fieldName,
      type: getFieldTypeString(pkField, ctx),
      required: true,
      columnName: pkColName,
      source: "pk" as const,
    }],
    returns: { type: rowType, nullable: true, isArray: false },
    callSignature: { style: "named" as const },
  };

  return { name, fn, meta };
};

const generateListMany = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, explicitColumns, dbAsParameter, defaultLimit } = ctx;
  if (!entity.permissions.canSelect) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);

  let query: n.Expression = chain(
    chain(selectColumns(selectFrom(tableRef), entity, explicitColumns), "limit", [id("limit")]),
    "offset",
    [id("offset")],
  );

  if (executeQueries) {
    query = chain(query, "execute");
  }

  const optionsParam = param.destructured([
    { name: "limit", type: ts.number(), optional: true, defaultValue: b.numericLiteral(defaultLimit) },
    { name: "offset", type: ts.number(), optional: true, defaultValue: b.numericLiteral(0) },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "ListMany");
  const rowType = entity.shapes.row.name;
  const meta = {
    name,
    kind: "list" as const,
    params: [
      { name: "limit", type: "number", required: false, source: "pagination" as const },
      { name: "offset", type: "number", required: false, source: "pagination" as const },
    ],
    returns: { type: rowType, nullable: false, isArray: true },
    callSignature: { style: "named" as const },
  };

  return { name, fn, meta };
};

const generateCreate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.permissions.canInsert) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const tableTypeName = getTableTypeName(entity);

  let query: n.Expression = chain(
    chain(insertInto(tableRef), "values", [id("data")]),
    "returningAll",
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow");
  }

  const optionsParam = param.destructured([
    { name: "data", type: ts.ref("Insertable", [ts.ref(tableTypeName)]) },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Create");
  const rowType = entity.shapes.row.name;
  const insertType = `Insertable<${tableTypeName}>`;
  const meta = {
    name,
    kind: "create" as const,
    params: [{
      name: "data",
      type: insertType,
      required: true,
      source: "body" as const,
    }],
    returns: { type: rowType, nullable: false, isArray: false },
    callSignature: { style: "named" as const, bodyStyle: "property" as const },
  };

  return { name, fn, meta };
};

const generateUpdate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.primaryKey || !entity.permissions.canUpdate) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);
  const tableTypeName = getTableTypeName(entity);

  let query: n.Expression = chain(
    chain(chain(updateTable(tableRef), "set", [id("data")]), "where", [
      str(pkColName),
      str("="),
      id(fieldName),
    ]),
    "returningAll",
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow");
  }

  const optionsParam = param.destructured([
    { name: fieldName, type: fieldType },
    { name: "data", type: ts.ref("Updateable", [ts.ref(tableTypeName)]) },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Update");
  const rowType = entity.shapes.row.name;
  const updateType = `Updateable<${tableTypeName}>`;
  const meta = {
    name,
    kind: "update" as const,
    params: [
      {
        name: fieldName,
        type: getFieldTypeString(pkField, ctx),
        required: true,
        columnName: pkColName,
        source: "pk" as const,
      },
      {
        name: "data",
        type: updateType,
        required: true,
        source: "body" as const,
      },
    ],
    returns: { type: rowType, nullable: false, isArray: false },
    callSignature: { style: "named" as const, bodyStyle: "property" as const },
  };

  return { name, fn, meta };
};

const generateDelete = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);

  let query: n.Expression = chain(deleteFrom(tableRef), "where", [
    str(pkColName),
    str("="),
    id(fieldName),
  ]);

  if (executeQueries) {
    query = chain(query, "execute");
  }

  const optionsParam = param.destructured([{ name: fieldName, type: fieldType }]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Remove");
  const meta = {
    name,
    kind: "delete" as const,
    params: [{
      name: fieldName,
      type: getFieldTypeString(pkField, ctx),
      required: true,
      columnName: pkColName,
      source: "pk" as const,
    }],
    returns: { type: "void", nullable: false, isArray: false },
    callSignature: { style: "named" as const },
  };

  return { name, fn, meta };
};

const generateCrudMethods = (ctx: GenerationContext): ReadonlyArray<MethodDef> =>
  [
    generateFindById(ctx),
    ctx.generateListMany ? generateListMany(ctx) : undefined,
    generateCreate(ctx),
    generateUpdate(ctx),
    generateDelete(ctx),
  ].filter((p): p is MethodDef => p != null);

// ============================================================================
// Import Collection (Types)
// ============================================================================

interface CollectedImports {
  readonly kyselyImports: Set<string>;
  readonly externalImports: Map<string, Set<string>>;
  readonly needsJsonTypes: boolean;
  readonly needsArrayType: boolean;
  readonly needsGenerated: boolean;
}

const collectImports = (
  entities: ReadonlyArray<TableEntity>,
  composites: ReadonlyArray<CompositeEntity>,
  ctx: FieldContext,
): CollectedImports => {
  const kyselyImports = new Set<string>();
  const externalImports = new Map<string, Set<string>>();
  let needsJsonTypes = false;
  let needsArrayType = false;
  let needsGenerated = false;

  const processField = (field: Field, schemaName: string, tableName: string, checkGenerated: boolean) => {
    const kyselyType = resolveFieldTypeForKysely(field, {
      ...ctx,
      schemaName,
      tableName,
    });

    if (kyselyType.needsColumnType) {
      kyselyImports.add("ColumnType");
    }

    if (kyselyType.externalImport) {
      const { name, from } = kyselyType.externalImport;
      if (!externalImports.has(from)) {
        externalImports.set(from, new Set());
      }
      externalImports.get(from)!.add(name);
    }
    // Note: Enum types are generated in the same file, no import needed

    const pgType = field.pgAttribute.getType();
    if (pgType?.typname === "json" || pgType?.typname === "jsonb") {
      needsJsonTypes = true;
    }

    if (field.isArray && kyselyType.needsColumnType) {
      needsArrayType = true;
    }

    if (checkGenerated && isGeneratedField(field)) {
      needsGenerated = true;
    }
  };

  for (const entity of entities) {
    if (!entity.permissions.canSelect) continue;
    for (const field of entity.shapes.row.fields) {
      if (!field.permissions.canSelect) continue;
      processField(field, entity.schemaName, entity.pgName, true);
    }
  }

  for (const composite of composites) {
    for (const field of composite.fields) {
      processField(field, composite.schemaName, composite.pgName, false);
    }
  }

  return {
    kyselyImports,
    externalImports,
    needsJsonTypes,
    needsArrayType,
    needsGenerated,
  };
};

// ============================================================================
// Statement Generators (Types)
// ============================================================================

const generateEnumStatement = (enumEntity: EnumEntity): SymbolStatement => {
  return exp.typeAlias(
    enumEntity.name,
    { capability: "types", entity: enumEntity.name },
    ts.union(...enumEntity.values.map(v => ts.literal(v)))
  );
};

const generateTableInterface = (entity: TableEntity, ctx: FieldContext): SymbolStatement => {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const field of entity.shapes.row.fields) {
    if (!field.permissions.canSelect) continue;

    const kyselyType = resolveFieldTypeForKysely(field, ctx);
    const needsGenerated = isGeneratedField(field);
    const fieldType = buildFieldType(field, kyselyType, needsGenerated);

    properties.push({
      name: field.name,
      type: fieldType,
    });
  }

  return exp.interface(
    entity.name,
    { capability: "types", entity: entity.name },
    properties
  );
};

const generateCompositeInterface = (composite: CompositeEntity, ctx: FieldContext): SymbolStatement => {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const field of composite.fields) {
    const kyselyType = resolveFieldTypeForKysely(field, ctx);
    const fieldType = buildFieldType(field, kyselyType, false);

    properties.push({
      name: field.name,
      type: fieldType,
    });
  }

  return exp.interface(
    composite.name,
    { capability: "types", entity: composite.name },
    properties
  );
};

const generateDBInterface = (entities: ReadonlyArray<TableEntity>, defaultSchemas: ReadonlyArray<string>, dbTypeName: string): SymbolStatement => {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const entity of entities) {
    if (!entity.permissions.canSelect) continue;

    const key = defaultSchemas.includes(entity.schemaName)
      ? entity.pgName
      : `${entity.schemaName}.${entity.pgName}`;

    properties.push({
      name: key,
      type: ts.ref(entity.name),
    });
  }

  properties.sort((a, b) => a.name.localeCompare(b.name));

  return exp.interface(
    dbTypeName,
    { capability: "types", entity: dbTypeName },
    properties
  );
};

// ============================================================================
// Export Style Helpers (Queries)
// ============================================================================

const toFlatExports = (methods: ReadonlyArray<MethodDef>): n.Statement[] =>
  methods.map(m => conjure.export.const(m.name, m.fn));

const toNamespaceExport = (entityName: string, methods: ReadonlyArray<MethodDef>): n.Statement => {
  const properties = methods.map(m => b.objectProperty(id(m.name), m.fn));
  const obj = b.objectExpression(properties);
  return conjure.export.const(entityName, obj);
};

const toStatements = (
  methods: ReadonlyArray<MethodDef>,
  exportStyle: "flat" | "namespace",
  entityName: string,
): n.Statement[] => {
  if (methods.length === 0) return [];
  return exportStyle === "namespace"
    ? [toNamespaceExport(entityName, methods)]
    : toFlatExports(methods);
};

// ============================================================================
// Main Generation Function
// ============================================================================

export function kysely(config: KyselyConfig): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(KyselyConfigSchema)(config);

  const defaultExportName: ExportNameFn = (_entityName, methodName) =>
    methodName.charAt(0).toLowerCase() + methodName.slice(1);

  // Compute dbTypesPath from dbTypeName if not explicitly provided
  // Both DB types and query files are in the same outputDir, so use "./" not "../"
  const dbTypesPath = config.dbTypesPath ?? `./${parsed.dbTypeName}.js`;

  const resolvedConfig = {
    ...parsed,
    dbTypesPath,
    exportName: parsed.exportName ?? defaultExportName,
  };

  return definePlugin({
    name: "kysely",
    kind: "queries",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: ReadonlyArray<unknown>, ctx: PluginContext): void => {
      const { ir, typeHints } = ctx;
      const enumEntities = getEnumEntities(ir);
      const compositeEntities = getCompositeEntities(ir).filter(e => e.tags.omit !== true);
      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);
      const defaultSchemas = ir.schemas;

      const dbTypeName = parsed.dbTypeName;

      // ================================================================
      // Generate Types (DB.ts)
      // ================================================================

      const fieldCtx: FieldContext = {
        schemaName: "",
        tableName: "",
        enums: enumEntities,
        composites: compositeEntities,
        extensions: ir.extensions,
        typeHints,
        defaultSchemas,
      };

      const imports = collectImports(tableEntities, compositeEntities, fieldCtx);

      const statements: SymbolStatement[] = [];

      for (const enumEntity of enumEntities) {
        if (enumEntity.tags.omit === true) continue;
        statements.push(generateEnumStatement(enumEntity));
      }

      for (const composite of compositeEntities) {
        statements.push(
          generateCompositeInterface(composite, {
            ...fieldCtx,
            schemaName: composite.schemaName,
            tableName: composite.pgName,
          })
        );
      }

      for (const entity of tableEntities) {
        statements.push(
          generateTableInterface(entity, {
            ...fieldCtx,
            schemaName: entity.schemaName,
            tableName: entity.pgName,
          })
        );
      }

      statements.push(generateDBInterface(tableEntities, defaultSchemas, dbTypeName));

      const dbFilePath = `${parsed.outputDir}/${dbTypeName}.ts`;
      const dbFile = ctx.file(dbFilePath);

      if (imports.kyselyImports.size > 0) {
        dbFile.import({
          kind: "package",
          types: [...imports.kyselyImports],
          from: "kysely",
        });
      }

      for (const [from, names] of imports.externalImports) {
        dbFile.import({
          kind: "relative",
          types: [...names],
          from,
        });
      }

      const helperTypes: string[] = [];

      if (imports.needsGenerated) {
        helperTypes.push(`export type Generated<T> = ${GENERATED_TYPE_DEF};`);
      }

      if (imports.needsArrayType) {
        helperTypes.push(`export type ArrayType<T> = ${ARRAY_TYPE_DEF};`);
        helperTypes.push(`export type ArrayTypeImpl<T> = ${ARRAY_TYPE_IMPL_DEF};`);
      }

      if (imports.needsJsonTypes) {
        helperTypes.push(`export type JsonPrimitive = boolean | number | string | null;`);
        helperTypes.push(`export type JsonObject = { [x: string]: JsonValue | undefined };`);
        helperTypes.push(`export type JsonArray = JsonValue[];`);
        helperTypes.push(`export type JsonValue = JsonArray | JsonObject | JsonPrimitive;`);
      }

      if (helperTypes.length > 0) {
        dbFile.header(helperTypes.join("\n\n"));
      }

      dbFile.ast(conjure.symbolProgram(...statements)).emit();

      // ================================================================
      // Generate Queries
      // ================================================================

      if (!parsed.generateQueries) {
        return;
      }

      const exportName = resolvedConfig.exportName;
      const exportStyle = resolvedConfig.exportStyle;

      for (const entity of tableEntities) {
        const entityName = entity.name;
        const filePath = `${parsed.outputDir}/${entityName}.ts`;
        const file = ctx.file(filePath);

        const genCtx: GenerationContext = {
          entity,
          enums: enumEntities,
          ir,
          defaultSchemas,
          dbTypesPath: resolvedConfig.dbTypesPath,
          executeQueries: parsed.executeQueries,
          generateListMany: parsed.generateListMany,
          entityName,
          exportName,
          explicitColumns: parsed.explicitColumns,
          dbAsParameter: parsed.dbAsParameter,
          defaultLimit: parsed.defaultLimit,
        };

        const methods = generateCrudMethods(genCtx);

        if (methods.length === 0) {
          continue;
        }

        if (parsed.header) {
          file.header(parsed.header);
        }

        // Build kysely imports based on what's actually used
        const kyselyTypes: string[] = [];
        if (parsed.dbAsParameter) {
          kyselyTypes.push("Kysely");
        }
        if (methods.some((m) => m.meta.kind === "create")) {
          kyselyTypes.push("Insertable");
        }
        if (methods.some((m) => m.meta.kind === "update")) {
          kyselyTypes.push("Updateable");
        }
        // Selectable would be used for explicit return types, but we use returningAll()

        if (kyselyTypes.length > 0) {
          file.import({
            kind: "package",
            types: kyselyTypes,
            from: "kysely",
          });
        }

        // Only import DB if dbAsParameter is true
        const dbImportTypes = parsed.dbAsParameter ? [dbTypeName, entityName] : [entityName];
        file.import({
          kind: "relative",
          types: dbImportTypes,
          from: resolvedConfig.dbTypesPath,
        });

        const stmts = toStatements(methods, exportStyle, entityName);
        file.ast(conjure.program(...stmts)).emit();

        const pkType = entity.primaryKey
          ? getFieldTypeString(findRowField(entity, entity.primaryKey.columns[0]!), genCtx)
          : "unknown";

        ctx.symbols.registerEntityMethods(
          {
            entity: entityName,
            importPath: filePath,
            pkType,
            hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
            methods: methods.map(m => ({
              name: m.meta.name,
              file: filePath,
              entity: entityName,
              kind: m.meta.kind,
              params: m.meta.params.map(p => ({
                name: p.name,
                type: p.type,
                required: p.required,
                columnName: p.columnName,
                source: p.source,
              })),
              returns: m.meta.returns,
              lookupField: m.meta.lookupField,
              isUniqueLookup: m.meta.isUniqueLookup,
              callSignature: m.meta.callSignature,
            })),
          },
          "kysely",
        );
      }
    },
  });
}
