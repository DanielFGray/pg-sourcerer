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
import { Array as A, Effect, Order, pipe, Option } from "effect";
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../runtime/types.js";
import { SymbolRegistry } from "../runtime/registry.js";
import { Conjure } from "../services/conjure.js";
import { IRExtensions } from "../services/ir-extensions.js";
import type { ExternalImport } from "../runtime/emit.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import {
  getTableEntities,
  getEnumEntities,
  getCompositeEntities,
  getCursorPaginationCandidates,
  type TableEntity,
  type EnumEntity,
  type CompositeEntity,
  type Field,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import { ENTITY_QUERIES_KEY, type QueryMethod, type EntityQueriesExtension } from "../ir/extensions/queries.js";
import { type UserModuleRef } from "../user-module.js";
import { getPgType, pgTypeToTsType, resolveFieldTypeInfo } from "./shared/pg-types.js";

const { fn, stmt, ts, param, str, b, chain, arrExpr } = conjure;

const createQueryConsume = (method: QueryMethod) => (input: unknown): n.Expression => {
  const args = input == null ? [] : [cast.toExpr(input as n.Expression)];
  const callExpr = b.callExpression(b.identifier(method.name), args);
  const executeMethod =
    method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)
      ? "executeTakeFirst"
      : method.kind === "create" || method.kind === "update"
        ? "executeTakeFirstOrThrow"
        : "execute";
  return b.callExpression(b.memberExpression(callExpr, b.identifier(executeMethod)), []);
};

/** Result of generating a query - contains statement and method metadata */
interface QueryGenResult {
  readonly statement: n.Statement;
  readonly method: QueryMethod;
}

const combineQueryResults = (results: readonly QueryGenResult[]): {
  statements: readonly n.Statement[];
  methods: readonly QueryMethod[];
} => ({
  statements: results.map(r => r.statement),
  methods: results.map(r => r.method),
});

// ============================================================================
// Configuration
// ============================================================================

const KyselyConfigSchema = S.Struct({
  /** Generate query functions (default: true) */
  generateQueries: S.optionalWith(S.Boolean, { default: () => true }),
  /** If true, db is passed as first parameter; if false, imported via dbImport */
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
 *
 * @example
 * // With database import (recommended)
 * kysely({
 *   dbImport: userModule("./db.ts", { named: ["db"] }),
 * })
 */
export interface KyselyConfig {
  /** Generate query functions (default: true) */
  generateQueries?: boolean;
  /**
   * Import for the database instance.
   * Use userModule() helper to specify the path relative to your config file.
   *
   * @example
   * ```typescript
   * import { userModule } from "pg-sourcerer";
   *
   * kysely({
   *   dbImport: userModule("./db.ts", { named: ["db"] }),
   * })
   * ```
   */
  dbImport?: UserModuleRef;
  /** If true, db is passed as first parameter; if false, imported via dbImport */
  dbAsParameter?: boolean;
  /** Default limit for list queries (default: 50) */
  defaultLimit?: number;
  /**
   * Output file path for all Kysely types (single file).
   * All entity types, enums, composites, and DB interface go here.
   * @default "DB.ts"
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
  dbImport?: UserModuleRef;
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

function getResolvedTypeName(field: Field): string {
  const resolved = resolveFieldTypeInfo(field);
  return resolved?.typeName ?? getPgType(field);
}

function getResolvedTypeInfo(field: Field) {
  const resolved = resolveFieldTypeInfo(field);
  return resolved?.typeInfo ?? field.pgAttribute.getType();
}

/**
 * Resolve a field to its Kysely type.
 */
function resolveFieldType(field: Field, ctx: TypeContext): KyselyType {
  const typeName = getResolvedTypeName(field);
  const typeInfo = getResolvedTypeInfo(field);

  // Check if it's an enum
  if (typeInfo?.typtype === "e") {
    const enumDef = ctx.enums.find(e => e.pgType.typname === typeName);
    if (enumDef) {
      return {
        selectType: ts.ref(enumDef.name),
        needsColumnType: false,
      };
    }
  }

  // Check if it's a composite type
  if (typeInfo?.typtype === "c") {
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
  // If complex type, wrap in ColumnType<S, I, U>
  const columnType =
    kyselyType.needsColumnType && kyselyType.insertType && kyselyType.updateType
      ? ts.ref("ColumnType", [kyselyType.selectType, kyselyType.insertType, kyselyType.updateType])
      : kyselyType.selectType;

  // Wrap in array if needed
  const arrayWrapped = field.isArray
    ? kyselyType.needsColumnType
      ? ts.ref("ArrayType", [columnType])
      : ts.array(columnType)
    : columnType;

  // Wrap in nullable if needed
  const nullableWrapped = field.nullable ? ts.union(arrayWrapped, ts.null()) : arrayWrapped;

  // Wrap in Generated<T> if field has default and is not insertable
  return needsGenerated ? ts.ref("Generated", [nullableWrapped]) : nullableWrapped;
}

// ============================================================================
// Type Generation
// ============================================================================

/**
 * Generate enum type alias: `export type Status = "active" | "inactive"`
 */
function generateEnumType(enumEntity: EnumEntity): n.Statement {
  return conjure.export.type(
    enumEntity.name,
    ts.union(...enumEntity.values.map(v => ts.literal(v))),
  );
}

/**
 * Generate composite type interface.
 */
function generateCompositeInterface(composite: CompositeEntity, ctx: TypeContext): n.Statement {
  const properties = composite.fields.map(field => ({
    name: field.name,
    type: buildFieldType(field, resolveFieldType(field, ctx), false),
  }));

  return conjure.export.interface(composite.name, properties);
}

/**
 * Generate table interface with all column types.
 */
function generateTableInterface(entity: TableEntity, ctx: TypeContext): n.Statement {
  const properties = entity.shapes.row.fields
    .filter(field => field.permissions.canSelect)
    .map(field => ({
      name: field.name,
      type: buildFieldType(field, resolveFieldType(field, ctx), isGeneratedField(field)),
    }));

  return conjure.export.interface(entity.name, properties);
}

/**
 * Generate DB interface: `export interface DB { table_name: TableType }`
 */
function generateDBInterface(entities: readonly TableEntity[], defaultSchemas: readonly string[]): n.Statement {
  const byName = Order.mapInput(Order.string, (p: { name: string }) => p.name);

  const properties = pipe(
    entities,
    A.filter(entity => entity.permissions.canSelect),
    A.map(entity => ({
      name: defaultSchemas.includes(entity.schemaName)
        ? entity.pgName
        : `${entity.schemaName}.${entity.pgName}`,
      type: ts.ref(entity.name),
    })),
    A.sort(byName),
  );

  return conjure.export.interface("DB", properties);
}

// ============================================================================
// Type Generation Helpers for Conjure exp.* methods
// ============================================================================

interface InterfaceProp {
  name: string;
  type: n.TSType;
}

/**
 * Generate enum union type: `"active" | "inactive"`
 * Returns just the TSType, not the full statement.
 */
function generateEnumUnionType(enumEntity: EnumEntity): n.TSType {
  return ts.union(...enumEntity.values.map(v => ts.literal(v)));
}

/**
 * Generate composite interface properties.
 */
function generateCompositeProps(composite: CompositeEntity, ctx: TypeContext): InterfaceProp[] {
  return composite.fields.map(field => ({
    name: field.name,
    type: buildFieldType(field, resolveFieldType(field, ctx), false),
  }));
}

/**
 * Generate table interface properties with all column types.
 */
function generateTableProps(entity: TableEntity, ctx: TypeContext): InterfaceProp[] {
  return entity.shapes.row.fields
    .filter(field => field.permissions.canSelect)
    .map(field => ({
      name: field.name,
      type: buildFieldType(field, resolveFieldType(field, ctx), isGeneratedField(field)),
    }));
}

/**
 * Generate DB interface properties.
 */
function generateDBProps(
  entities: readonly TableEntity[],
  defaultSchemas: readonly string[],
): InterfaceProp[] {
  const byName = Order.mapInput(Order.string, (p: { name: string }) => p.name);

  return pipe(
    entities,
    A.filter(entity => entity.permissions.canSelect),
    A.map(entity => ({
      name: defaultSchemas.includes(entity.schemaName)
        ? entity.pgName
        : `${entity.schemaName}.${entity.pgName}`,
      type: ts.ref(entity.name),
    })),
    A.sort(byName),
  );
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
  // Analyze a field and return what imports it requires
  const analyzeField = (field: Field, checkGenerated: boolean) => {
    const typeName = getResolvedTypeName(field);
    const kyselyType = resolveFieldType(field, ctx);

    return {
      needsColumnType: kyselyType.needsColumnType,
      needsJsonTypes: typeName === "json" || typeName === "jsonb",
      needsArrayType: field.isArray && kyselyType.needsColumnType,
      needsGenerated: checkGenerated && isGeneratedField(field),
    };
  };

  // Get all table fields that can be selected
  const tableFieldAnalyses = entities
    .filter(entity => entity.permissions.canSelect)
    .flatMap(entity =>
      entity.shapes.row.fields
        .filter(field => field.permissions.canSelect)
        .map(field => analyzeField(field, true)),
    );

  // Get all composite fields
  const compositeFieldAnalyses = composites.flatMap(composite =>
    composite.fields.map(field => analyzeField(field, false)),
  );

  // Merge all analyses with logical OR
  const allAnalyses = [...tableFieldAnalyses, ...compositeFieldAnalyses];

  return {
    needsColumnType: allAnalyses.some(a => a.needsColumnType),
    needsGenerated: allAnalyses.some(a => a.needsGenerated),
    needsArrayType: allAnalyses.some(a => a.needsArrayType),
    needsJsonTypes: allAnalyses.some(a => a.needsJsonTypes),
  };
}

/**
 * Build the helper types header string.
 */
function buildTypesHeader(imports: TypeImports): string {
  return [
    imports.needsGenerated && `export type Generated<T> = ${GENERATED_TYPE_DEF};`,
    imports.needsArrayType && `export type ArrayType<T> = ${ARRAY_TYPE_DEF};`,
    imports.needsArrayType && `export type ArrayTypeImpl<T> = ${ARRAY_TYPE_IMPL_DEF};`,
    imports.needsJsonTypes && `export type JsonPrimitive = boolean | number | string | null;`,
    imports.needsJsonTypes && `export type JsonObject = { [x: string]: JsonValue | undefined };`,
    imports.needsJsonTypes && `export type JsonArray = JsonValue[];`,
    imports.needsJsonTypes && `export type JsonValue = JsonArray | JsonObject | JsonPrimitive;`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ============================================================================
// Query Generation Helpers
// ============================================================================

function buildColumnArray(fields: readonly Field[]): n.ArrayExpression {
  return conjure.arr(...fields.map(f => str(f.columnName))).build();
}

function buildQueryName(inflection: CoreInflection, entityName: string, operation: string): string {
  return inflection.variableName(entityName, operation);
}

function buildFindByName(inflection: CoreInflection, entityName: string, columnName: string): string {
  return inflection.variableName(entityName, `FindBy${inflection.pascalCase(columnName)}`);
}

function buildListByName(inflection: CoreInflection, entityName: string, columnName: string): string {
  return inflection.variableName(entityName, `ListBy${inflection.pascalCase(columnName)}`);
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

/**
 * Create a function builder, optionally adding db as first parameter.
 */
function createFnBuilder(dbAsParameter: boolean) {
  return dbAsParameter ? fn().param("db", ts.ref("Kysely")) : fn();
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
    typesFile: config?.typesFile ?? "DB.ts",
    queriesFile: normalizeFileNaming(config?.queriesFile, "queries.ts"),
    dbImport: config?.dbImport,
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

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const inflection = yield* Inflection;
      const registry = yield* SymbolRegistry;
      const cj = yield* Conjure;
      const extensions = yield* IRExtensions;

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

      const typesExternalImports: ExternalImport[] =
        kyselyTypeImports.length > 0 ? [{ from: "kysely", types: kyselyTypeImports }] : [];

      // Generate enum types
      const enumStmts = yield* Effect.forEach(
        enumEntities.filter(e => e.tags.omit !== true),
        enumEntity =>
          cj.exp.type(enumEntity.name, generateEnumUnionType(enumEntity), {
            capability: `types:kysely:${enumEntity.name}`,
            imports: typesExternalImports,
          }),
      );

      // Generate composite interfaces
      const compositeStmts = yield* Effect.forEach(compositeEntities, composite =>
        cj.exp.interface(composite.name, generateCompositeProps(composite, typeCtx), {
          capability: `types:kysely:${composite.name}`,
          imports: typesExternalImports,
        }),
      );

      // Generate table interfaces
      const tableTypeStmts = yield* Effect.forEach(tableEntities, entity =>
        cj.exp.interface(entity.name, generateTableProps(entity, typeCtx), {
          capability: `types:kysely:${entity.name}`,
          imports: typesExternalImports,
        }),
      );

      // Generate DB interface
      const dbStmt = yield* cj.exp.interface("DB", generateDBProps(tableEntities, defaultSchemas), {
        capability: "types:kysely:DB",
        imports: typesExternalImports,
      });

      // Generate queries if enabled
      if (!resolvedConfig.generateQueries) {
        return [...enumStmts, ...compositeStmts, ...tableTypeStmts, dbStmt];
      }

      const queryUserImports: readonly UserModuleRef[] | undefined =
        !resolvedConfig.dbAsParameter && resolvedConfig.dbImport
          ? [resolvedConfig.dbImport]
          : undefined;

      const kyselyImport = resolvedConfig.dbAsParameter ? [{ from: "kysely", names: ["Kysely"] }] : [];

      // Helper to generate query and register it
      const generateQuery = (
        name: string,
        capability: string,
        fnExpr: n.Expression,
        method: QueryMethod,
        imports: ExternalImport[],
      ) =>
        cj.exp.const(name, fnExpr, {
          capability,
          imports,
          userImports: queryUserImports,
          consume: createQueryConsume(method),
        });

      // Generate queries for each entity
      const queryResults = yield* Effect.forEach(tableEntities, entity =>
        Effect.gen(function* () {
          const entityName = entity.name;
          const tableName = ir.schemas.includes(entity.schemaName)
            ? entity.pgName
            : `${entity.schemaName}.${entity.pgName}`;
          const methods: QueryMethod[] = [];
          const stmts: n.Statement[] = [];

          // findById
          if (entity.permissions.canSelect && entity.primaryKey?.columns[0]) {
            const pkColumn = entity.primaryKey.columns[0];
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
            if (pkField) {
              const pkParam = buildPkParam(pkField);
              const method: QueryMethod = {
                name: buildQueryName(inflection, entityName, "FindById"),
                kind: "read",
                params: [pkParam],
                returns: buildReturnType(entityName, false, true),
                callSignature: { style: "named" },
              };
              methods.push(method);

              const queryExpr = chain(b.identifier("db") as n.Expression)
                .method("selectFrom", [str(tableName) as n.Expression])
                .method("select", [buildColumnArray(entity.shapes.row.fields)])
                .method("where", [str(pkColumn), str("="), b.identifier(pkField.name)])
                .build();

              const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter)
                .rawParam(buildDestructuredParam([pkParam]))
                .arrow()
                .body(stmt.return(queryExpr))
                .build();

              const s = yield* generateQuery(
                method.name,
                `queries:kysely:${entityName}:findById`,
                fnExpr,
                method,
                kyselyImport,
              );
              stmts.push(s);
            }
          }

          // listByCursor for indexed timestamptz columns
          for (const candidate of getCursorPaginationCandidates(entity)) {
            const pkField = entity.shapes.row.fields.find(f => f.name === candidate.pkColumn);
            if (!pkField) continue;

            const pascalColumn = inflection.pascalCase(candidate.cursorColumnName);
            const pkParamType = pgTypeToTsType(getResolvedTypeName(pkField));
            const cursorColumnParamName = inflection.camelCase(`cursor_${candidate.cursorColumnName}`);
            const cursorPkParamName = inflection.camelCase(`cursor_${candidate.pkColumnName}`);

            const method: QueryMethod = {
              name: buildListByName(inflection, entityName, candidate.cursorColumnName),
              kind: "list",
              params: [
                { name: cursorColumnParamName, type: "Date", required: false, source: "pagination" },
                { name: cursorPkParamName, type: pkParamType, required: false, source: "pagination" },
                { name: "limit", type: "number", required: false, source: "pagination" },
              ],
              returns: buildReturnType(entityName, true, false),
              callSignature: { style: "named" },
            };
            methods.push(method);

            const cursorParam = param.destructured([
              { name: cursorColumnParamName, type: ts.ref("Date"), optional: true },
              { name: cursorPkParamName, type: ts.ref(pkParamType), optional: true },
              { name: "limit", type: ts.number(), optional: true, defaultValue: conjure.num(resolvedConfig.defaultLimit) },
            ]);

            const cursorComparisonOp = candidate.desc ? "<" : ">";
            const orderDirection = candidate.desc ? "desc" : "asc";
            const cursorColumnExpr = b.tsNonNullExpression(b.identifier(cursorColumnParamName));
            const cursorPkExpr = b.tsNonNullExpression(b.identifier(cursorPkParamName));

            const cursorCondition = b.callExpression(b.identifier("eb"), [str(candidate.cursorColumnName), str(cursorComparisonOp), cursorColumnExpr]);
            const pkCondition = b.callExpression(b.identifier("eb"), [str(candidate.pkColumnName), str(cursorComparisonOp), cursorPkExpr]);
            const equalityCondition = b.callExpression(b.identifier("eb"), [str(candidate.cursorColumnName), str("="), cursorColumnExpr]);
            const andClause = chain(b.identifier("eb")).method("and", [arrExpr(equalityCondition, pkCondition)]).build();
            const whereClause = chain(b.identifier("eb")).method("or", [arrExpr(cursorCondition, andClause)]).build();

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("selectFrom", [str(tableName) as n.Expression])
              .method("select", [buildColumnArray(entity.shapes.row.fields)])
              .method("$if", [
                b.logicalExpression("&&",
                  b.binaryExpression("!==", b.identifier(cursorColumnParamName), b.identifier("undefined")),
                  b.binaryExpression("!==", b.identifier(cursorPkParamName), b.identifier("undefined")),
                ),
                fn().param("qb").arrow().body(
                  stmt.return(chain(b.identifier("qb") as n.Expression)
                    .method("where", [(b.arrowFunctionExpression([b.identifier("eb")], cast.toExpr(whereClause)) as n.Expression)])
                    .build()),
                ).build(),
              ] as n.Expression[])
              .method("orderBy", [str(candidate.cursorColumnName), str(orderDirection)])
              .method("orderBy", [str(candidate.pkColumnName), str(orderDirection)])
              .method("limit", [b.identifier("limit")])
              .build();

            const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter).rawParam(cursorParam).arrow().body(stmt.return(queryExpr)).build();

            const s = yield* generateQuery(
              method.name,
              `queries:kysely:${entityName}:listBy${pascalColumn}`,
              fnExpr,
              method,
              kyselyImport,
            );
            stmts.push(s);
          }

          // create
          if (entity.kind === "table" && entity.permissions.canInsert && entity.shapes.insert) {
            const bodyParam = buildBodyParam(entityName, "insert");
            const method: QueryMethod = {
              name: buildQueryName(inflection, entityName, "Create"),
              kind: "create",
              params: [bodyParam],
              returns: buildReturnType(entityName, false, false),
              callSignature: { style: "named", bodyStyle: "spread" },
            };
            methods.push(method);

            const queryExpr = chain(b.identifier("db") as n.Expression)
              .method("insertInto", [str(tableName) as n.Expression])
              .method("values", [b.identifier("data") as n.Expression])
              .method("returningAll", [])
              .build();

            const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter)
              .param("data", ts.ref("Insertable", [ts.ref(entityName)]))
              .arrow()
              .body(stmt.return(queryExpr))
              .build();

            const s = yield* generateQuery(method.name, `queries:kysely:${entityName}:create`, fnExpr, method, [
              { from: "kysely", names: resolvedConfig.dbAsParameter ? ["Kysely"] : [], types: ["Insertable"] },
              { from: resolvedConfig.typesFile, types: [entityName] },
            ]);
            stmts.push(s);
          }

          // update
          if (entity.kind === "table" && entity.permissions.canUpdate && entity.shapes.update && entity.primaryKey?.columns[0]) {
            const pkColumn = entity.primaryKey.columns[0];
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
            if (pkField) {
              const pkParam = buildPkParam(pkField);
              const bodyParam = buildBodyParam(entityName, "update");
              const method: QueryMethod = {
                name: buildQueryName(inflection, entityName, "Update"),
                kind: "update",
                params: [pkParam, bodyParam],
                returns: buildReturnType(entityName, false, true),
                callSignature: { style: "named", bodyStyle: "spread" },
              };
              methods.push(method);

              const queryExpr = chain(b.identifier("db") as n.Expression)
                .method("updateTable", [str(tableName) as n.Expression])
                .method("set", [b.identifier("data") as n.Expression])
                .method("where", [str(pkColumn), str("="), b.identifier(pkField.name)])
                .method("returningAll", [])
                .build();

              const destructuredParam = param.withRest(
                [{ name: pkField.name, type: ts.ref(pkParam.type) }],
                "data",
                ts.ref("Omit", [ts.ref("Updateable", [ts.ref(entityName)]), ts.literal(pkField.name)]),
              );
              const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter).rawParam(destructuredParam).arrow().body(stmt.return(queryExpr)).build();

              const s = yield* generateQuery(method.name, `queries:kysely:${entityName}:update`, fnExpr, method, [
                { from: "kysely", names: resolvedConfig.dbAsParameter ? ["Kysely"] : [], types: ["Updateable"] },
                { from: resolvedConfig.typesFile, types: [entityName] },
              ]);
              stmts.push(s);
            }
          }

          // delete
          if (entity.kind === "table" && entity.permissions.canDelete && entity.primaryKey?.columns[0]) {
            const pkColumn = entity.primaryKey.columns[0];
            const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
            if (pkField) {
              const pkParam = buildPkParam(pkField);
              const method: QueryMethod = {
                name: buildQueryName(inflection, entityName, "Delete"),
                kind: "delete",
                params: [pkParam],
                returns: buildReturnType(entityName, false, false),
                callSignature: { style: "named" },
              };
              methods.push(method);

              const queryExpr = chain(b.identifier("db") as n.Expression)
                .method("deleteFrom", [str(tableName) as n.Expression])
                .method("where", [str(pkColumn), str("="), b.identifier(pkField.name)])
                .build();

              const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter)
                .rawParam(buildDestructuredParam([pkParam]))
                .arrow()
                .body(stmt.return(queryExpr))
                .build();

              const s = yield* generateQuery(method.name, `queries:kysely:${entityName}:delete`, fnExpr, method, kyselyImport);
              stmts.push(s);
            }
          }

          // findBy indexes
          if (entity.permissions.canSelect) {
            const pkColumns = new Set(entity.primaryKey?.columns ?? []);
            const seenColumns = new Set<string>();

            for (const index of entity.indexes) {
              if (index.isPartial || index.hasExpressions || index.columns.length !== 1) continue;
              if (index.method === "gin" || index.method === "gist") continue;

              const columnName = index.columns[0]!;
              if (pkColumns.has(columnName) || seenColumns.has(columnName)) continue;
              seenColumns.add(columnName);

              const field = entity.shapes.row.fields.find(f => f.columnName === columnName);
              if (!field) continue;

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
              methods.push(method);

              const queryExpr = chain(b.identifier("db") as n.Expression)
                .method("selectFrom", [str(tableName) as n.Expression])
                .method("select", [buildColumnArray(entity.shapes.row.fields)])
                .method("where", [str(columnName), str("="), b.identifier(field.name)])
                .build();

              const fnExpr = createFnBuilder(resolvedConfig.dbAsParameter)
                .rawParam(buildDestructuredParam([lookupParam]))
                .arrow()
                .body(stmt.return(queryExpr))
                .build();

              const s = yield* generateQuery(
                method.name,
                `queries:kysely:${entityName}:findBy${pascalColumn}`,
                fnExpr,
                method,
                kyselyImport,
              );
              stmts.push(s);
            }
          }

          // Store EntityQueriesExtension as virtual symbol (metadata only, no AST)
          const pkField = entity.primaryKey?.columns[0]
            ? entity.shapes.row.fields.find(f => f.columnName === entity.primaryKey!.columns[0])
            : undefined;

          const entityExtension: EntityQueriesExtension = {
            methods,
            pkType: pkField ? pgTypeToTsType(getResolvedTypeName(pkField)) : undefined,
            hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
          };

          // Store entity queries metadata for HTTP plugins
          extensions.setEntry(ENTITY_QUERIES_KEY, entityName, entityExtension);

          return stmts;
        }),
      );

      return [...enumStmts, ...compositeStmts, ...tableTypeStmts, dbStmt, ...A.flatten(queryResults)];
    }),
  };
}
