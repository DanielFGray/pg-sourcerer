/**
 * Kysely Types Plugin - Generate Kysely-compatible type definitions
 *
 * Generates table interfaces with Generated<T>, ColumnType<S, I, U>, and DB interface.
 * Uses RLS permissions to determine Generated<T> wrapping.
 *
 * Output structure:
 * - Helper type definitions (Generated, ArrayType, ColumnType imports)
 * - Enum type aliases
 * - Table interfaces with column types
 * - DB interface mapping table names to interfaces
 */
import { Array as Arr, Option, pipe, Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import { findEnumByPgName, PgTypeOid } from "../services/pg-types.js"
import type {
  Field,
  TableEntity,
  EnumEntity,
  ExtensionInfo,
} from "../ir/semantic-ir.js"
import { getEnumEntities, getTableEntities } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"
import type { SymbolStatement } from "../lib/conjure.js"
import type { ImportRef } from "../services/file-builder.js"
import type { TypeHintRegistry, TypeHintFieldMatch } from "../services/type-hints.js"
import {
  isEnumType,
  getPgTypeName,
} from "../lib/field-utils.js"
import { getExtensionTypeMapping } from "../services/pg-types.js"

const { ts, exp } = conjure

// ============================================================================
// Configuration
// ============================================================================

const KyselyTypesPluginConfig = S.Struct({
  /** Output file path */
  outputFile: S.optionalWith(S.String, { default: () => "db.ts" }),
  /** Use runtime enums instead of string literal unions */
  runtimeEnums: S.optionalWith(S.Boolean, { default: () => false }),
  /** Use type-only imports (recommended) */
  typeOnlyImports: S.optionalWith(S.Boolean, { default: () => true }),
})

// ============================================================================
// Types
// ============================================================================

/** Context for field type resolution */
interface FieldContext {
  readonly schemaName: string
  readonly tableName: string
  readonly enums: readonly EnumEntity[]
  readonly extensions: readonly ExtensionInfo[]
  readonly typeHints: TypeHintRegistry
  readonly defaultSchemas: readonly string[]
}

/** Kysely type complexity - whether to use ColumnType<S, I, U> */
interface KyselyType {
  /** The select type (what you get back from queries) */
  readonly selectType: n.TSType
  /** The insert type (what you provide for inserts) - differs for Generated */
  readonly insertType?: n.TSType
  /** The update type (what you provide for updates) */
  readonly updateType?: n.TSType
  /** Whether this needs ColumnType wrapper */
  readonly needsColumnType: boolean
  /** Optional import for external types */
  readonly externalImport?: { name: string; from: string }
}

// ============================================================================
// Helper Type Definitions (ported from kysely-codegen)
// ============================================================================

/**
 * Build Generated<T> type alias as raw TypeScript string.
 * 
 * Generated marks columns that have defaults and don't need to be provided on insert.
 * 
 * type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
 *   ? ColumnType<S, I | undefined, U>
 *   : ColumnType<T, T | undefined, T>;
 */
const GENERATED_TYPE_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>`

/**
 * Build ArrayType<T> helper for complex array types.
 * 
 * type ArrayType<T> = ArrayTypeImpl<T> extends (infer U)[]
 *   ? U[]
 *   : ArrayTypeImpl<T>;
 */
const ARRAY_TYPE_DEF = `ArrayTypeImpl<T> extends (infer U)[]
  ? U[]
  : ArrayTypeImpl<T>`

/**
 * Build ArrayTypeImpl<T> helper.
 * 
 * type ArrayTypeImpl<T> = T extends ColumnType<infer S, infer I, infer U>
 *   ? ColumnType<S[], I[], U[]>
 *   : T[];
 */
const ARRAY_TYPE_IMPL_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S[], I[], U[]>
  : T[]`

// ============================================================================
// PostgreSQL Type Mappings (ported from kysely-codegen postgres-adapter)
// ============================================================================

/**
 * Simple scalar mappings: PG type name → TS type
 * These don't need ColumnType wrapper.
 */
const SCALAR_TYPES: Record<string, () => n.TSType> = {
  // Boolean
  bool: ts.boolean,
  
  // Integers → number
  int2: ts.number,
  int4: ts.number,
  float4: ts.number,
  float8: ts.number,
  oid: ts.number,
  
  // Text types → string
  text: ts.string,
  varchar: ts.string,
  bpchar: ts.string, // blank-padded char
  char: ts.string,
  name: ts.string,
  bit: ts.string,
  varbit: ts.string,
  xml: ts.string,
  
  // UUID → string
  uuid: ts.string,
  
  // Network types → string
  inet: ts.string,
  cidr: ts.string,
  macaddr: ts.string,
  macaddr8: ts.string,
  
  // Geometric types → string (typically serialized)
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
}

/**
 * Complex types that need ColumnType<Select, Insert, Update> wrapper.
 * These have different types for select vs insert/update.
 */
interface ComplexTypeMapping {
  /** Select type (what you get back) */
  readonly select: () => n.TSType
  /** Insert type (what you can provide) */
  readonly insert: () => n.TSType
  /** Update type (what you can provide) */
  readonly update: () => n.TSType
  /** External import required */
  readonly import?: { name: string; from: string }
}

const COMPLEX_TYPES: Record<string, ComplexTypeMapping> = {
  // int8/bigint: returns string (to avoid precision loss), accepts string|number|bigint
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
  
  // Interval: For now, defer to string until we decide on postgres-interval
  interval: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number()),
    update: () => ts.union(ts.string(), ts.number()),
  },
  
  // JSON: returns JsonValue, accepts JsonValue
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
  
  // Geometric: Point and Circle have object representations
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
}

// ============================================================================
// Type Resolution
// ============================================================================

/** Build TypeHintFieldMatch from field and context */
const buildFieldMatch = (field: Field, ctx: FieldContext): TypeHintFieldMatch => ({
  schema: ctx.schemaName,
  table: ctx.tableName,
  column: field.columnName,
  pgType: field.isArray && field.elementTypeName
    ? field.elementTypeName
    : field.pgAttribute.getType()?.typname ?? "",
})

/**
 * Resolve a field to its Kysely type.
 * Handles: TypeHints, enums, complex types, scalar types, extensions.
 */
function resolveFieldType(field: Field, ctx: FieldContext): KyselyType {
  const pgType = field.pgAttribute.getType()
  const typeName = pgType?.typname ?? ""
  
  // 1. Check TypeHints first (highest priority)
  const fieldMatch = buildFieldMatch(field, ctx)
  const tsTypeHint = ctx.typeHints.getHint<string>(fieldMatch, "tsType")
  
  if (Option.isSome(tsTypeHint)) {
    const typeName = tsTypeHint.value
    const importPath = ctx.typeHints.getHint<string>(fieldMatch, "import")
    return {
      selectType: ts.ref(typeName),
      needsColumnType: false,
      externalImport: pipe(
        importPath,
        Option.map(path => ({ name: typeName, from: path })),
        Option.getOrUndefined
      ),
    }
  }
  
  // 2. Check if it's an enum
  if (isEnumType(field)) {
    const enumName = getPgTypeName(field)
    if (enumName) {
      const enumDef = findEnumByPgName(ctx.enums, enumName)
      if (Option.isSome(enumDef)) {
        return {
          selectType: ts.ref(enumDef.value.name),
          needsColumnType: false,
        }
      }
    }
  }
  
  // 3. Check complex types (need ColumnType wrapper)
  const complexType = COMPLEX_TYPES[typeName]
  if (complexType) {
    return {
      selectType: complexType.select(),
      insertType: complexType.insert(),
      updateType: complexType.update(),
      needsColumnType: true,
      externalImport: complexType.import,
    }
  }
  
  // 4. Check simple scalar types
  const scalarBuilder = SCALAR_TYPES[typeName]
  if (scalarBuilder) {
    return {
      selectType: scalarBuilder(),
      needsColumnType: false,
    }
  }
  
  // 5. Check extension types (citext, etc.)
  if (pgType) {
    const extType = getExtensionTypeMapping(
      typeName,
      String(pgType.typnamespace),
      ctx.extensions
    )
    if (Option.isSome(extType)) {
      return {
        selectType: tsTypeToAst(extType.value),
        needsColumnType: false,
      }
    }
  }
  
  // 6. Default to string (PostgreSQL sends unknown types as strings)
  return {
    selectType: ts.string(),
    needsColumnType: false,
  }
}

/** Convert a simple TS type string to AST */
function tsTypeToAst(typeName: string): n.TSType {
  switch (typeName) {
    case "string": return ts.string()
    case "number": return ts.number()
    case "boolean": return ts.boolean()
    case "bigint": return ts.bigint()
    case "unknown": return ts.unknown()
    case "null": return ts.null()
    case "Date": return ts.ref("Date")
    case "Buffer": return ts.ref("Buffer")
    default: return ts.ref(typeName)
  }
}

/**
 * Build the final field type with array/nullable/Generated wrappers.
 */
function buildFieldType(
  field: Field,
  kyselyType: KyselyType,
  needsGenerated: boolean
): n.TSType {
  let baseType: n.TSType
  
  // If complex type, wrap in ColumnType<S, I, U>
  if (kyselyType.needsColumnType && kyselyType.insertType && kyselyType.updateType) {
    baseType = ts.ref("ColumnType", [
      kyselyType.selectType,
      kyselyType.insertType,
      kyselyType.updateType,
    ])
  } else {
    baseType = kyselyType.selectType
  }
  
  // Wrap in array if needed
  if (field.isArray) {
    // For simple types, use T[]
    // For complex types, use ArrayType<T>
    if (kyselyType.needsColumnType) {
      baseType = ts.ref("ArrayType", [baseType])
    } else {
      baseType = ts.array(baseType)
    }
  }
  
  // Wrap in nullable if needed
  if (field.nullable) {
    baseType = ts.union(baseType, ts.null())
  }
  
  // Wrap in Generated<T> if field has default and is not insertable
  if (needsGenerated) {
    baseType = ts.ref("Generated", [baseType])
  }
  
  return baseType
}

/**
 * Determine if a field should be wrapped in Generated<T>.
 * 
 * A field is Generated when:
 * - It has a default value, AND
 * - It's not required on insert (either auto-increment or RLS blocks insert)
 */
function isGeneratedField(field: Field): boolean {
  if (!field.hasDefault) return false
  
  // If field can't be inserted via RLS, it's generated
  if (!field.permissions.canInsert) return true
  
  // Check for serial/identity columns (auto-incrementing)
  const pgType = field.pgAttribute.getType()
  if (!pgType) return false
  
  // Check for identity columns (GENERATED ALWAYS AS IDENTITY)
  if (field.isIdentity) return true
  
  // Check for generated columns (GENERATED ALWAYS AS ...)
  if (field.isGenerated) return true
  
  // serial types have specific OIDs that resolve to int4/int8
  // but the attribute itself may have attidentity or atthasdef
  // For now, use a heuristic: if it's an integer with a default, likely generated
  const typeOid = Number(pgType._id)
  const isIntegerType = typeOid === PgTypeOid.Int2 
    || typeOid === PgTypeOid.Int4 
    || typeOid === PgTypeOid.Int8
  
  // If it's an integer primary key with a default, it's likely auto-increment
  // This is a simplification - proper detection would check sequences
  if (isIntegerType && field.hasDefault) {
    // Check if it's a primary key (best effort)
    const constraints = field.pgAttribute.getClass()?.getConstraints() ?? []
    const isPrimaryKey = constraints.some(
      c => c.contype === "p" && c.conkey?.includes(field.pgAttribute.attnum)
    )
    if (isPrimaryKey) return true
  }
  
  return false
}

// ============================================================================
// Statement Generators
// ============================================================================

/**
 * Generate the helper type definitions (Generated, ArrayType, etc.)
 */
function generateHelperTypes(): n.Statement[] {
  const b = conjure
  
  // We'll emit these as raw type alias strings since they use complex conditionals
  // that are easier to express as strings than AST
  return []  // These will be added via file.header() or raw content
}

/**
 * Generate enum type alias: `export type Status = "active" | "inactive"`
 */
function generateEnumStatement(enumEntity: EnumEntity): SymbolStatement {
  return exp.typeAlias(
    enumEntity.name,
    { capability: "types:kysely", entity: enumEntity.name },
    ts.union(...enumEntity.values.map(v => ts.literal(v)))
  )
}

/**
 * Generate table interface with all column types.
 */
function generateTableInterface(
  entity: TableEntity,
  ctx: FieldContext
): SymbolStatement {
  const properties: Array<{ name: string; type: n.TSType; optional?: boolean }> = []
  
  // Use the row shape for column definitions
  for (const field of entity.shapes.row.fields) {
    // Skip fields that aren't selectable via RLS
    if (!field.permissions.canSelect) continue
    
    const kyselyType = resolveFieldType(field, ctx)
    const needsGenerated = isGeneratedField(field)
    const fieldType = buildFieldType(field, kyselyType, needsGenerated)
    
    properties.push({
      name: field.name,
      type: fieldType,
    })
  }
  
  return exp.interface(
    entity.name,
    { capability: "types:kysely", entity: entity.name },
    properties
  )
}

/**
 * Generate DB interface: `export interface DB { 'schema.table': Table }`
 */
function generateDBInterface(
  entities: readonly TableEntity[],
  defaultSchemas: readonly string[]
): SymbolStatement {
  const properties: Array<{ name: string; type: n.TSType }> = []
  
  for (const entity of entities) {
    // Skip entities that aren't selectable
    if (!entity.permissions.canSelect) continue
    
    // Use schema-qualified key if not in default schema
    const key = defaultSchemas.includes(entity.schemaName)
      ? entity.pgName
      : `${entity.schemaName}.${entity.pgName}`
    
    properties.push({
      name: key,
      type: ts.ref(entity.name),
    })
  }
  
  // Sort by key for stable output
  properties.sort((a, b) => a.name.localeCompare(b.name))
  
  return exp.interface(
    "DB",
    { capability: "types:kysely", entity: "DB" },
    properties
  )
}

// ============================================================================
// Collect Required Imports
// ============================================================================

interface CollectedImports {
  readonly kyselyImports: Set<string>
  readonly externalImports: Map<string, Set<string>>  // path → names
  readonly usedEnums: Set<string>
  readonly needsJsonTypes: boolean
  readonly needsArrayType: boolean
  readonly needsGenerated: boolean
}

function collectImports(
  entities: readonly TableEntity[],
  ctx: FieldContext
): CollectedImports {
  const kyselyImports = new Set<string>()
  const externalImports = new Map<string, Set<string>>()
  const usedEnums = new Set<string>()
  let needsJsonTypes = false
  let needsArrayType = false
  let needsGenerated = false
  
  for (const entity of entities) {
    if (!entity.permissions.canSelect) continue
    
    for (const field of entity.shapes.row.fields) {
      if (!field.permissions.canSelect) continue
      
      const kyselyType = resolveFieldType(field, {
        ...ctx,
        schemaName: entity.schemaName,
        tableName: entity.pgName,
      })
      
      // Check for ColumnType usage
      if (kyselyType.needsColumnType) {
        kyselyImports.add("ColumnType")
      }
      
      // Check for external imports
      if (kyselyType.externalImport) {
        const { name, from } = kyselyType.externalImport
        if (!externalImports.has(from)) {
          externalImports.set(from, new Set())
        }
        externalImports.get(from)!.add(name)
      }
      
      // Check for enum usage
      if (isEnumType(field)) {
        const enumName = getPgTypeName(field)
        if (enumName) {
          const enumDef = findEnumByPgName(ctx.enums, enumName)
          if (Option.isSome(enumDef)) {
            usedEnums.add(enumDef.value.name)
          }
        }
      }
      
      // Check for JSON types
      const pgType = field.pgAttribute.getType()
      if (pgType?.typname === "json" || pgType?.typname === "jsonb") {
        needsJsonTypes = true
      }
      
      // Check for complex array types
      if (field.isArray && kyselyType.needsColumnType) {
        needsArrayType = true
      }
      
      // Check for Generated
      if (isGeneratedField(field)) {
        needsGenerated = true
      }
    }
  }
  
  return {
    kyselyImports,
    externalImports,
    usedEnums,
    needsJsonTypes,
    needsArrayType,
    needsGenerated,
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Kysely Types Plugin
 *
 * Generates Kysely-compatible type definitions from SemanticIR.
 * Uses RLS permissions to determine Generated<T> wrapping.
 *
 * @example Generated output:
 * ```typescript
 * import type { ColumnType } from 'kysely';
 *
 * export type Generated<T> = ...
 *
 * export type Status = 'active' | 'inactive';
 *
 * export interface Users {
 *   id: Generated<string>;
 *   name: string;
 *   email: string | null;
 * }
 *
 * export interface DB {
 *   users: Users;
 * }
 * ```
 */
export const kyselyTypesPlugin = definePlugin({
  name: "kysely-types",
  provides: ["types:kysely"],
  configSchema: KyselyTypesPluginConfig,
  inflection: {
    outputFile: () => "db.ts",
    symbolName: (entityName) => entityName,
  },

  run: (ctx, config) => {
    const { ir, typeHints } = ctx
    const enumEntities = getEnumEntities(ir)
    const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true)
    const defaultSchemas = ir.schemas
    
    // Build field context
    const fieldCtx: FieldContext = {
      schemaName: "",  // Will be set per-entity
      tableName: "",
      enums: enumEntities,
      extensions: ir.extensions,
      typeHints,
      defaultSchemas,
    }
    
    // Collect what imports we need
    const imports = collectImports(tableEntities, fieldCtx)
    
    // Build statements
    const statements: SymbolStatement[] = []
    
    // Generate enum types
    for (const enumEntity of enumEntities) {
      if (enumEntity.tags.omit === true) continue
      statements.push(generateEnumStatement(enumEntity))
    }
    
    // Generate table interfaces
    for (const entity of tableEntities) {
      statements.push(generateTableInterface(entity, {
        ...fieldCtx,
        schemaName: entity.schemaName,
        tableName: entity.pgName,
      }))
    }
    
    // Generate DB interface
    statements.push(generateDBInterface(tableEntities, defaultSchemas))
    
    // Build the file
    const file = ctx.file(config.outputFile)
    
    // Add Kysely imports
    if (imports.kyselyImports.size > 0) {
      file.import({
        kind: "package",
        types: [...imports.kyselyImports],
        from: "kysely",
      })
    }
    
    // Add external imports
    for (const [from, names] of imports.externalImports) {
      file.import({
        kind: "relative",
        types: [...names],
        from,
      })
    }
    
    // Build header with helper types
    const helperTypes: string[] = []
    
    if (imports.needsGenerated) {
      helperTypes.push(`export type Generated<T> = ${GENERATED_TYPE_DEF};`)
    }
    
    if (imports.needsArrayType) {
      helperTypes.push(`export type ArrayType<T> = ${ARRAY_TYPE_DEF};`)
      helperTypes.push(`export type ArrayTypeImpl<T> = ${ARRAY_TYPE_IMPL_DEF};`)
    }
    
    if (imports.needsJsonTypes) {
      helperTypes.push(`export type JsonPrimitive = boolean | number | string | null;`)
      helperTypes.push(`export type JsonObject = { [x: string]: JsonValue | undefined };`)
      helperTypes.push(`export type JsonArray = JsonValue[];`)
      helperTypes.push(`export type JsonValue = JsonArray | JsonObject | JsonPrimitive;`)
    }
    
    if (helperTypes.length > 0) {
      file.header(helperTypes.join("\n\n"))
    }
    
    // Add the main content
    file.ast(conjure.symbolProgram(...statements)).emit()
  },
})
