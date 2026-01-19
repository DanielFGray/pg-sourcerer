/**
 * Kysely Plugin - Unified Kysely types and query functions
 *
 * Generates:
 * 1. Kysely-compatible type definitions (DB interface, table types with Generated<T>)
 * 2. Type-safe CRUD query functions using Kysely's fluent API
 *
 * This plugin is incompatible with other type-generation plugins (types, zod, etc.)
 * since it provides its own type definitions optimized for Kysely.
 */
import { Effect, Array as Arr, Option, pipe } from "effect";
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../runtime/types.js";
import type { RenderedSymbolWithImports, ExternalImport } from "../runtime/emit.js";
import { normalizeFileNaming, type FileNamingContext, type FileNaming } from "../runtime/file-assignment.js";
import { IR } from "../services/ir.js";
import {
  isTableEntity,
  getTableEntities,
  getEnumEntities,
  getCompositeEntities,
  type TableEntity,
  type EnumEntity,
  type CompositeEntity,
  type Field,
} from "../ir/semantic-ir.js";
import { conjure } from "../conjure/index.js";
import type { QueryMethod, EntityQueriesExtension } from "../ir/extensions/queries.js";

const { fn, stmt, ts, param, str, exp, b, chain } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const KyselyConfigSchema = S.Struct({
  /** Generate query functions (default: true) */
  generateQueries: S.optionalWith(S.Boolean, { default: () => true }),
  /** Header to prepend to generated files (use for db import) */
  header: S.optionalWith(S.String, { default: () => "" }),
  /** If true, db is passed as first parameter; if false, imported via header */
  dbAsParameter: S.optionalWith(S.Boolean, { default: () => false }),
  /** Default limit for list queries (default: 50) */
  defaultLimit: S.optionalWith(S.Number, { default: () => 50 }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof KyselyConfigSchema>;

/**
 * Kysely plugin configuration.
 *
 * @example
 * // Basic usage - all types in db.ts, all queries in queries.ts
 * kysely()
 *
 * @example
 * // Per-entity query files with single types file
 * kysely({
 *   typesFile: "db/types.ts",
 *   queriesFile: ({ entityName }) => `${entityName.toLowerCase()}/queries.ts`,
 * })
 */
export interface KyselyConfig {
  /** Generate query functions (default: true) */
  generateQueries?: boolean;
  /** Header to prepend to generated files (use for db import) */
  header?: string;
  /** If true, db is passed as first parameter; if false, imported via header */
  dbAsParameter?: boolean;
  /** Default limit for list queries (default: 50) */
  defaultLimit?: number;
  /**
   * Output file path for all Kysely types (single file).
   * All entity types, enums, composites, and DB interface go here.
   * @default "db.ts"
   */
  typesFile?: string;
  /**
   * Output file path for queries.
   * Can be a string (static path) or function (dynamic per entity).
   * @default "queries.ts"
   */
  queriesFile?: string | FileNaming;
}

/** Resolved config with defaults applied */
interface ResolvedKyselyConfig extends SchemaConfig {
  typesFile: string;
  queriesFile: FileNaming;
}

// ============================================================================
// Kysely Type Helpers (ported from kysely-codegen)
// ============================================================================

/**
 * Helper type definitions to be emitted in the types file.
 */
const GENERATED_TYPE_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>`;

const ARRAY_TYPE_DEF = `ArrayTypeImpl<T> extends (infer U)[]
  ? U[]
  : ArrayTypeImpl<T>`;

const ARRAY_TYPE_IMPL_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S[], I[], U[]>
  : T[]`;

// ============================================================================
// PostgreSQL Type Mappings
// ============================================================================

/** Simple scalar types: PG type → TS type builder */
const SCALAR_TYPES: Record<string, () => n.TSType> = {
  // Boolean
  bool: ts.boolean,
  boolean: ts.boolean,

  // Integers → number
  int2: ts.number,
  int4: ts.number,
  float4: ts.number,
  float8: ts.number,
  oid: ts.number,

  // Text types → string
  text: ts.string,
  varchar: ts.string,
  bpchar: ts.string,
  char: ts.string,
  name: ts.string,
  bit: ts.string,
  varbit: ts.string,
  xml: ts.string,
  citext: ts.string,

  // UUID → string
  uuid: ts.string,

  // Network types → string
  inet: ts.string,
  cidr: ts.string,
  macaddr: ts.string,
  macaddr8: ts.string,

  // Geometric types → string
  line: ts.string,
  lseg: ts.string,
  box: ts.string,
  path: ts.string,
  polygon: ts.string,

  // Time without date → string
  time: ts.string,
  timetz: ts.string,

  // Full-text search → string
  tsvector: ts.string,
  tsquery: ts.string,
  txid_snapshot: ts.string,

  // Money → string
  money: ts.string,

  // Binary → Buffer
  bytea: () => ts.ref("Buffer"),
};

/** Complex types that need ColumnType<Select, Insert, Update> wrapper */
interface ComplexTypeMapping {
  readonly select: () => n.TSType;
  readonly insert: () => n.TSType;
  readonly update: () => n.TSType;
}

const COMPLEX_TYPES: Record<string, ComplexTypeMapping> = {
  // int8/bigint: returns string, accepts string|number|bigint
  int8: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number(), ts.bigint()),
    update: () => ts.union(ts.string(), ts.number(), ts.bigint()),
  },

  // numeric/decimal: returns string, accepts number|string
  numeric: {
    select: ts.string,
    insert: () => ts.union(ts.number(), ts.string()),
    update: () => ts.union(ts.number(), ts.string()),
  },

  // Timestamps: returns Date, accepts Date|string
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

  // Interval: string for now
  interval: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number()),
    update: () => ts.union(ts.string(), ts.number()),
  },

  // JSON: JsonValue
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

  // Point: object with x, y
  point: {
    select: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
    insert: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
    update: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
  },
};

// ============================================================================
// Type Resolution
// ============================================================================

interface KyselyType {
  readonly selectType: n.TSType;
  readonly insertType?: n.TSType;
  readonly updateType?: n.TSType;
  readonly needsColumnType: boolean;
}

interface TypeContext {
  readonly enums: readonly EnumEntity[];
  readonly composites: readonly CompositeEntity[];
}

/**
 * Resolve a field to its Kysely type.
 */
function resolveFieldType(field: Field, ctx: TypeContext): KyselyType {
  const pgType = field.pgAttribute.getType();
  const typeName = pgType?.typname ?? "";

  // Check if it's an enum
  if (pgType?.typtype === "e") {
    const enumDef = ctx.enums.find(e => e.pgType.typname === typeName);
    if (enumDef) {
      return {
        selectType: ts.ref(enumDef.name),
        needsColumnType: false,
      };
    }
  }

  // Check if it's a composite type
  if (pgType?.typtype === "c") {
    const compositeDef = ctx.composites.find(c => c.pgType.typname === typeName);
    if (compositeDef) {
      return {
        selectType: ts.ref(compositeDef.name),
        needsColumnType: false,
      };
    }
  }

  // Check complex types (need ColumnType wrapper)
  const complexType = COMPLEX_TYPES[typeName];
  if (complexType) {
    return {
      selectType: complexType.select(),
      insertType: complexType.insert(),
      updateType: complexType.update(),
      needsColumnType: true,
    };
  }

  // Check simple scalar types
  const scalarBuilder = SCALAR_TYPES[typeName];
  if (scalarBuilder) {
    return {
      selectType: scalarBuilder(),
      needsColumnType: false,
    };
  }

  // Default to string
  return {
    selectType: ts.string(),
    needsColumnType: false,
  };
}

/**
 * Determine if a field should be wrapped in Generated<T>.
 *
 * A field needs Generated<T> wrapper (making it optional in Insertable<T>) if:
 * 1. The role cannot insert this field (permission-denied → treat as if generated)
 * 2. The field has a database default and is an identity/generated column
 * 3. The field has a default that will be used if not provided
 *
 * This ensures Kysely's Insertable<T> aligns with IR insert shapes which
 * exclude fields the role cannot insert.
 */
function isGeneratedField(field: Field): boolean {
  // If role can't insert this field, make it optional in Insertable<T>
  // This matches IR behavior where such fields are excluded from insert shape
  if (!field.permissions.canInsert) return true;

  // Fields with any kind of default are optional on insert
  // (identity columns, generated columns, or any DEFAULT value)
  if (field.hasDefault) return true;
  if (field.isIdentity) return true;
  if (field.isGenerated) return true;

  return false;
}

/**
 * Build the final field type with array/nullable/Generated wrappers.
 */
function buildFieldType(field: Field, kyselyType: KyselyType, needsGenerated: boolean): n.TSType {
  let baseType: n.TSType;

  // If complex type, wrap in ColumnType<S, I, U>
  if (kyselyType.needsColumnType && kyselyType.insertType && kyselyType.updateType) {
    baseType = ts.ref("ColumnType", [kyselyType.selectType, kyselyType.insertType, kyselyType.updateType]);
  } else {
    baseType = kyselyType.selectType;
  }

  // Wrap in array if needed
  if (field.isArray) {
    if (kyselyType.needsColumnType) {
      baseType = ts.ref("ArrayType", [baseType]);
    } else {
      baseType = ts.array(baseType);
    }
  }

  // Wrap in nullable if needed
  if (field.nullable) {
    baseType = ts.union(baseType, ts.null());
  }

  // Wrap in Generated<T> if field has default and is not insertable
  if (needsGenerated) {
    baseType = ts.ref("Generated", [baseType]);
  }

  return baseType;
}

// ============================================================================
// Type Generation
// ============================================================================

/**
 * Generate enum type alias: `export type Status = "active" | "inactive"`
 */
function generateEnumType(enumEntity: EnumEntity): n.Statement {
  return exp.typeAlias(
    enumEntity.name,
    { capability: "types:kysely", entity: enumEntity.name },
    ts.union(...enumEntity.values.map(v => ts.literal(v))),
  ).node;
}

/**
 * Generate composite type interface.
 */
function generateCompositeInterface(composite: CompositeEntity, ctx: TypeContext): n.Statement {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const field of composite.fields) {
    const kyselyType = resolveFieldType(field, ctx);
    const fieldType = buildFieldType(field, kyselyType, false);
    properties.push({ name: field.name, type: fieldType });
  }

  return exp.interface(composite.name, { capability: "types:kysely", entity: composite.name }, properties).node;
}

/**
 * Generate table interface with all column types.
 */
function generateTableInterface(entity: TableEntity, ctx: TypeContext): n.Statement {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const field of entity.shapes.row.fields) {
    if (!field.permissions.canSelect) continue;

    const kyselyType = resolveFieldType(field, ctx);
    const needsGenerated = isGeneratedField(field);
    const fieldType = buildFieldType(field, kyselyType, needsGenerated);

    properties.push({ name: field.name, type: fieldType });
  }

  return exp.interface(entity.name, { capability: "types:kysely", entity: entity.name }, properties).node;
}

/**
 * Generate DB interface: `export interface DB { table_name: TableType }`
 */
function generateDBInterface(entities: readonly TableEntity[], defaultSchemas: readonly string[]): n.Statement {
  const properties: Array<{ name: string; type: n.TSType }> = [];

  for (const entity of entities) {
    if (!entity.permissions.canSelect) continue;

    // Use schema-qualified key if not in default schema
    const key = defaultSchemas.includes(entity.schemaName) ? entity.pgName : `${entity.schemaName}.${entity.pgName}`;

    properties.push({ name: key, type: ts.ref(entity.name) });
  }

  // Sort by key for stable output
  properties.sort((a, b) => a.name.localeCompare(b.name));

  return exp.interface("DB", { capability: "types:kysely", entity: "DB" }, properties).node;
}

/**
 * Collect what imports are needed for types.
 */
interface TypeImports {
  needsColumnType: boolean;
  needsGenerated: boolean;
  needsArrayType: boolean;
  needsJsonTypes: boolean;
}

function collectTypeImports(
  entities: readonly TableEntity[],
  composites: readonly CompositeEntity[],
  ctx: TypeContext,
): TypeImports {
  let needsColumnType = false;
  let needsGenerated = false;
  let needsArrayType = false;
  let needsJsonTypes = false;

  const processField = (field: Field, checkGenerated: boolean) => {
    const pgType = field.pgAttribute.getType();
    const typeName = pgType?.typname ?? "";

    const kyselyType = resolveFieldType(field, ctx);

    if (kyselyType.needsColumnType) {
      needsColumnType = true;
    }

    if (typeName === "json" || typeName === "jsonb") {
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
      processField(field, true);
    }
  }

  for (const composite of composites) {
    for (const field of composite.fields) {
      processField(field, false);
    }
  }

  return { needsColumnType, needsGenerated, needsArrayType, needsJsonTypes };
}

/**
 * Build the helper types header string.
 */
function buildTypesHeader(imports: TypeImports): string {
  const lines: string[] = [];

  if (imports.needsGenerated) {
    lines.push(`export type Generated<T> = ${GENERATED_TYPE_DEF};`);
  }

  if (imports.needsArrayType) {
    lines.push(`export type ArrayType<T> = ${ARRAY_TYPE_DEF};`);
    lines.push(`export type ArrayTypeImpl<T> = ${ARRAY_TYPE_IMPL_DEF};`);
  }

  if (imports.needsJsonTypes) {
    lines.push(`export type JsonPrimitive = boolean | number | string | null;`);
    lines.push(`export type JsonObject = { [x: string]: JsonValue | undefined };`);
    lines.push(`export type JsonArray = JsonValue[];`);
    lines.push(`export type JsonValue = JsonArray | JsonObject | JsonPrimitive;`);
  }

  return lines.join("\n\n");
}

// ============================================================================
// Query Generation Helpers
// ============================================================================

function buildColumnArray(fields: readonly Field[]): n.ArrayExpression {
  return conjure.arr(...fields.map(f => str(f.columnName))).build();
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
 * Kysely plugin - generates Kysely-compatible types and query functions.
 *
 * Capabilities provided:
 * - `types:kysely:DB` - the DB interface
 * - `types:kysely:EntityName` - table/composite interfaces
 * - `queries:kysely:EntityName:operation` - CRUD query functions
 */
export function kysely(config?: KyselyConfig): Plugin {
  // Parse schema-validated options
  const schemaConfig = S.decodeSync(KyselyConfigSchema)(config ?? {});

  // Debug logging
  // Resolve file naming
  // typesFile is always a single static path (all types in one file)
  // queriesFile can be dynamic per-entity
  const resolvedConfig: ResolvedKyselyConfig = {
    ...schemaConfig,
    typesFile: config?.typesFile ?? "db.ts",
    queriesFile: normalizeFileNaming(config?.queriesFile, "queries.ts"),
  };

  return {
    name: "kysely",
    provides: ["queries"],
    consumes: [],

    fileDefaults: [
      {
        // All types go to a single file
        pattern: "types:kysely:",
        fileNaming: () => resolvedConfig.typesFile,
      },
      {
        pattern: "queries:kysely:",
        fileNaming: resolvedConfig.queriesFile,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;
      const declarations: SymbolDeclaration[] = [];

      const enumEntities = getEnumEntities(ir);
      const compositeEntities = getCompositeEntities(ir).filter(e => e.tags.omit !== true);
      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);

      // Declare types
      for (const enumEntity of enumEntities) {
        if (enumEntity.tags.omit === true) continue;
        declarations.push({
          name: enumEntity.name,
          capability: `types:kysely:${enumEntity.name}`,
        });
      }

      for (const composite of compositeEntities) {
        declarations.push({
          name: composite.name,
          capability: `types:kysely:${composite.name}`,
        });
      }

      for (const entity of tableEntities) {
        declarations.push({
          name: entity.name,
          capability: `types:kysely:${entity.name}`,
        });
      }

      declarations.push({
        name: "DB",
        capability: "types:kysely:DB",
      });

      // Declare queries if enabled
      if (resolvedConfig.generateQueries) {
        for (const entity of tableEntities) {
          const entityName = entity.name;
          let hasAnyMethods = false;

          if (entity.permissions.canSelect && entity.primaryKey && entity.primaryKey.columns.length > 0) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "findById"),
              capability: `queries:kysely:${entityName}:findById`,
              dependsOn: [`types:kysely:${entityName}`],
            });
          }

          if (entity.permissions.canSelect) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "list"),
              capability: `queries:kysely:${entityName}:list`,
              dependsOn: [`types:kysely:${entityName}`],
            });
          }

          if (entity.kind === "table" && entity.permissions.canInsert && entity.shapes.insert) {
            hasAnyMethods = true;
            declarations.push({
              name: buildQueryName(entityName, "create"),
              capability: `queries:kysely:${entityName}:create`,
              dependsOn: [`types:kysely:${entityName}`],
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
              capability: `queries:kysely:${entityName}:update`,
              dependsOn: [`types:kysely:${entityName}`],
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
              capability: `queries:kysely:${entityName}:delete`,
              dependsOn: [`types:kysely:${entityName}`],
            });
          }

          // findBy queries for indexed columns
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
                capability: `queries:kysely:${entityName}:findBy${pascalColumn}`,
                dependsOn: [`types:kysely:${entityName}`],
              });
            }
          }

          if (hasAnyMethods) {
            declarations.push({
              name: `${entityName}Queries`,
              capability: `queries:kysely:${entityName}`,
            });
          }
        }
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const symbols: RenderedSymbolWithImports[] = [];

      const enumEntities = getEnumEntities(ir);
      const compositeEntities = getCompositeEntities(ir).filter(e => e.tags.omit !== true);
      const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);
      const defaultSchemas = ir.schemas;

      const typeCtx: TypeContext = {
        enums: enumEntities,
        composites: compositeEntities,
      };

      // Collect imports for types
      const typeImports = collectTypeImports(tableEntities, compositeEntities, typeCtx);

      // Build kysely imports for types file
      const kyselyTypeImports: string[] = [];
      if (typeImports.needsColumnType) {
        kyselyTypeImports.push("ColumnType");
      }

      const typesHeader = buildTypesHeader(typeImports);
      const typesExternalImports: ExternalImport[] =
        kyselyTypeImports.length > 0 ? [{ from: "kysely", types: kyselyTypeImports }] : [];

      // Generate enum types
      for (const enumEntity of enumEntities) {
        if (enumEntity.tags.omit === true) continue;
        symbols.push({
          name: enumEntity.name,
          capability: `types:kysely:${enumEntity.name}`,
          node: generateEnumType(enumEntity),
          exports: "named",
          externalImports: typesExternalImports,
          fileHeader: typesHeader,
        });
      }

      // Generate composite interfaces
      for (const composite of compositeEntities) {
        symbols.push({
          name: composite.name,
          capability: `types:kysely:${composite.name}`,
          node: generateCompositeInterface(composite, typeCtx),
          exports: "named",
          externalImports: typesExternalImports,
          fileHeader: typesHeader,
        });
      }

      // Generate table interfaces
      for (const entity of tableEntities) {
        symbols.push({
          name: entity.name,
          capability: `types:kysely:${entity.name}`,
          node: generateTableInterface(entity, typeCtx),
          exports: "named",
          externalImports: typesExternalImports,
          fileHeader: typesHeader,
        });
      }

      // Generate DB interface
      symbols.push({
        name: "DB",
        capability: "types:kysely:DB",
        node: generateDBInterface(tableEntities, defaultSchemas),
        exports: "named",
        externalImports: typesExternalImports,
        fileHeader: typesHeader,
      });

      // Generate queries if enabled
      if (resolvedConfig.generateQueries) {
        const queryHeader =
          !resolvedConfig.dbAsParameter && resolvedConfig.header ? resolvedConfig.header : undefined;

        for (const entity of tableEntities) {
          const entityName = entity.name;
          const tableName = ir.schemas.includes(entity.schemaName)
            ? entity.pgName
            : `${entity.schemaName}.${entity.pgName}`;

          const entityMethods: QueryMethod[] = [];

          // findById
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

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("selectFrom", [str(tableName) as n.Expression])
              .method("select", [buildColumnArray(entity.shapes.row.fields)])
              .method("where", [
                str(pkColumn) as n.Expression,
                str("=") as n.Expression,
                b.identifier(pkField.name) as n.Expression,
              ])
              .build();

            const destructuredParam = buildDestructuredParam([pkParam]);
            let fnBuilder = fn();
            if (resolvedConfig.dbAsParameter) {
              fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
            }
            const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

            symbols.push({
              name: method.name,
              capability: `queries:kysely:${entityName}:findById`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: resolvedConfig.dbAsParameter ? [{ from: "kysely", names: ["Kysely"] }] : [],
              fileHeader: queryHeader,
            });
          }

          // list
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

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("selectFrom", [str(tableName) as n.Expression])
              .method("select", [buildColumnArray(entity.shapes.row.fields)])
              .method("limit", [b.identifier("limit") as n.Expression])
              .method("offset", [b.identifier("offset") as n.Expression])
              .build();

            const destructuredParam = buildDestructuredParam(paginationParams);
            let fnBuilder = fn();
            if (resolvedConfig.dbAsParameter) {
              fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
            }
            const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

            symbols.push({
              name: method.name,
              capability: `queries:kysely:${entityName}:list`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: resolvedConfig.dbAsParameter ? [{ from: "kysely", names: ["Kysely"] }] : [],
              fileHeader: queryHeader,
            });
          }

          // create
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

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("insertInto", [str(tableName) as n.Expression])
              .method("values", [b.identifier("data") as n.Expression])
              .method("returningAll", [])
              .build();

            const destructuredParam = buildDestructuredParam([bodyParam]);
            let fnBuilder = fn();
            if (resolvedConfig.dbAsParameter) {
              fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
            }
            const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

            symbols.push({
              name: method.name,
              capability: `queries:kysely:${entityName}:create`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: [
                {
                  from: "kysely",
                  names: resolvedConfig.dbAsParameter ? ["Kysely"] : [],
                  types: ["Insertable"],
                },
                {
                  from: resolvedConfig.typesFile,
                  types: [entityName],
                },
              ],
              fileHeader: queryHeader,
            });
          }

          // update
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

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("updateTable", [str(tableName) as n.Expression])
              .method("set", [b.identifier("data") as n.Expression])
              .method("where", [
                str(pkColumn) as n.Expression,
                str("=") as n.Expression,
                b.identifier(pkField.name) as n.Expression,
              ])
              .method("returningAll", [])
              .build();

            const destructuredParam = buildDestructuredParam([pkParam, bodyParam]);
            let fnBuilder = fn();
            if (resolvedConfig.dbAsParameter) {
              fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
            }
            const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

            symbols.push({
              name: method.name,
              capability: `queries:kysely:${entityName}:update`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: [
                {
                  from: "kysely",
                  names: resolvedConfig.dbAsParameter ? ["Kysely"] : [],
                  types: ["Updateable"],
                },
                {
                  from: resolvedConfig.typesFile,
                  types: [entityName],
                },
              ],
              fileHeader: queryHeader,
            });
          }

          // delete
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

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("deleteFrom", [str(tableName) as n.Expression])
              .method("where", [
                str(pkColumn) as n.Expression,
                str("=") as n.Expression,
                b.identifier(pkField.name) as n.Expression,
              ])
              .build();

            const destructuredParam = buildDestructuredParam([pkParam]);
            let fnBuilder = fn();
            if (resolvedConfig.dbAsParameter) {
              fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
            }
            const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

            symbols.push({
              name: method.name,
              capability: `queries:kysely:${entityName}:delete`,
              node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
              exports: "named",
              externalImports: resolvedConfig.dbAsParameter ? [{ from: "kysely", names: ["Kysely"] }] : [],
              fileHeader: queryHeader,
            });
          }

          // findBy queries for indexed columns
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

              const queryExpr = chain(b.identifier("db") as n.Expression)
                .method("selectFrom", [str(tableName) as n.Expression])
                .method("select", [buildColumnArray(entity.shapes.row.fields)])
                .method("where", [
                  str(columnName) as n.Expression,
                  str("=") as n.Expression,
                  b.identifier(field.name) as n.Expression,
                ])
                .build();

              const destructuredParam = buildDestructuredParam([lookupParam]);
              let fnBuilder = fn();
              if (resolvedConfig.dbAsParameter) {
                fnBuilder = fnBuilder.param("db", ts.ref("Kysely"));
              }
              const fnExpr = fnBuilder.rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

              symbols.push({
                name: method.name,
                capability: `queries:kysely:${entityName}:findBy${pascalColumn}`,
                node: exp.const(method.name, { capability: "", entity: entityName }, fnExpr).node,
                exports: "named",
                externalImports: resolvedConfig.dbAsParameter ? [{ from: "kysely", names: ["Kysely"] }] : [],
                fileHeader: queryHeader,
              });
            }
          }

          // Entity queries metadata (no importPath - emit phase handles file resolution)
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
            capability: `queries:kysely:${entityName}`,
            node: b.stringLiteral("") as unknown as n.Statement,
            metadata: entityExtension,
            exports: false,
          });
        }
      }

      return symbols;
    }),
  };
}
