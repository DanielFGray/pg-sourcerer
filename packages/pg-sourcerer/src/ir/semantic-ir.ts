/**
 * Semantic IR - Intermediate Representation of database schema
 * 
 * This is the core data structure that plugins consume.
 * It represents semantic intent, not code.
 */
import type { PgAttribute, PgClass, PgType } from "pg-introspection"
import type { SmartTags, ShapeKind } from "./smart-tags.js"

/**
 * Information about a domain type's underlying base type.
 * Used for type resolution when the column type is a domain.
 */
export interface DomainBaseTypeInfo {
  /** Base type name (e.g., "citext" for a domain over citext) */
  readonly typeName: string
  /** Base type OID (for OID-based type mapping) */
  readonly typeOid: number
  /** Base type namespace OID (for extension lookup) */
  readonly namespaceOid: string
  /** Base type category (e.g., 'S' for string) */
  readonly category: string
}

/**
 * A field within a shape - represents a column with semantic context
 */
export interface Field {
  /** Inflected field name (camelCase) */
  readonly name: string
  /** Original PostgreSQL column name */
  readonly columnName: string
  /** Raw attribute from pg-introspection */
  readonly pgAttribute: PgAttribute

  // Semantic properties (derived from pgAttribute for convenience)
  /** Can be NULL at runtime */
  readonly nullable: boolean
  /** Optional in this shape (e.g., has default for insert) */
  readonly optional: boolean
  /** Has DEFAULT or is GENERATED */
  readonly hasDefault: boolean
  /** GENERATED ALWAYS column */
  readonly isGenerated: boolean
  /** IDENTITY column */
  readonly isIdentity: boolean

  // Array handling
  /** PostgreSQL array type */
  readonly isArray: boolean
  /** For arrays, the element type name */
  readonly elementTypeName?: string

  // Domain type handling
  /** If the column type is a domain, info about the underlying base type */
  readonly domainBaseType?: DomainBaseTypeInfo

  /** Smart tags from comment */
  readonly tags: SmartTags

  /** Plugin-attached data (extensible, keyed by plugin name) */
  readonly extensions: ReadonlyMap<string, unknown>

  /** Permissions for the connected role */
  readonly permissions: FieldPermissions
}

/**
 * A shape is a structure with fields - the semantic description
 * that can become a TypeScript type, Zod schema, etc.
 */
export interface Shape {
  /** e.g., "UserRow", "UserInsert" */
  readonly name: string
  /** The kind of shape */
  readonly kind: ShapeKind
  /** Fields in this shape */
  readonly fields: readonly Field[]
}

/**
 * Relation between entities - inferred from foreign key constraints.
 * Contains raw constraint data; plugins derive names as needed.
 */
export interface Relation {
  /** Relationship kind */
  readonly kind: "hasMany" | "hasOne" | "belongsTo"
  /** Target entity name (not table name) */
  readonly targetEntity: string
  /** Original FK constraint name */
  readonly constraintName: string

  /** Column mappings (supports composite FKs) */
  readonly columns: readonly {
    readonly local: string
    readonly foreign: string
  }[]

  /** Smart tags from constraint comment */
  readonly tags: SmartTags
}

/**
 * Primary key information
 */
export interface PrimaryKey {
  /** Column names in the primary key */
  readonly columns: readonly string[]
  /** True if from @primaryKey tag, false if real PK constraint */
  readonly isVirtual: boolean
}

/**
 * Index method types
 */
export type IndexMethod = "btree" | "gin" | "gist" | "hash" | "brin" | "spgist"

/**
 * Information about a database index
 */
export interface IndexDef {
  /** PostgreSQL index name */
  readonly name: string
  /** Inflected column names (camelCase) */
  readonly columns: readonly string[]
  /** Original PostgreSQL column names */
  readonly columnNames: readonly string[]
  /** True if this is a unique index */
  readonly isUnique: boolean
  /** True if this is a primary key index */
  readonly isPrimary: boolean
  /** True if this is a partial index (has WHERE clause) */
  readonly isPartial: boolean
  /** WHERE clause for partial indexes (raw SQL) */
  readonly predicate?: string
  /** Index method (btree, gin, gist, hash, brin, spgist) */
  readonly method: IndexMethod
  /** True if any "column" is actually an expression (not a real column) */
  readonly hasExpressions: boolean
}

/**
 * Permissions for a field (column) based on connected role's ACLs
 */
export interface FieldPermissions {
  /** Column can be selected */
  readonly canSelect: boolean
  /** Column can be used in INSERT */
  readonly canInsert: boolean
  /** Column can be used in UPDATE */
  readonly canUpdate: boolean
}

/**
 * Permissions for an entity (table/view) based on connected role's ACLs
 */
export interface EntityPermissions {
  /** Table can be selected from */
  readonly canSelect: boolean
  /** Rows can be inserted */
  readonly canInsert: boolean
  /** Rows can be updated */
  readonly canUpdate: boolean
  /** Rows can be deleted */
  readonly canDelete: boolean
}

/**
 * An entity represents a table, view, or composite type
 */
export interface Entity {
  /** Inflected entity name (PascalCase) */
  readonly name: string
  /** Original PostgreSQL table/view name */
  readonly tableName: string
  /** PostgreSQL schema name */
  readonly schemaName: string
  /** Entity kind */
  readonly kind: "table" | "view" | "composite"
  /** Raw class from pg-introspection */
  readonly pgClass: PgClass

  /** Primary key (may be undefined for views without @primaryKey) */
  readonly primaryKey?: PrimaryKey

  /** Indexes on this entity */
  readonly indexes: readonly IndexDef[]

  /** Shapes for this entity */
  readonly shapes: {
    /** Row shape - always present */
    readonly row: Shape
    /** Insert shape - tables only */
    readonly insert?: Shape
    /** Update shape - tables only */
    readonly update?: Shape
    /** Patch shape - partial update */
    readonly patch?: Shape
  }

  /** Relations to other entities */
  readonly relations: readonly Relation[]

  /** Smart tags from table/view comment */
  readonly tags: SmartTags

  /** Permissions for the connected role */
  readonly permissions: EntityPermissions
}

/**
 * Enum definition from PostgreSQL
 */
export interface EnumDef {
  /** Inflected enum name (PascalCase) */
  readonly name: string
  /** Original PostgreSQL enum name */
  readonly pgName: string
  /** PostgreSQL schema name */
  readonly schemaName: string
  /** Raw type from pg-introspection */
  readonly pgType: PgType
  /** Enum values in order */
  readonly values: readonly string[]
  /** Smart tags from type comment */
  readonly tags: SmartTags
}

/**
 * Capability key - colon-separated hierarchical namespace
 * e.g., "types", "schemas", "schemas:zod", "queries:crud"
 */
export type CapabilityKey = string

/**
 * Artifact - plugin output stored in IR for downstream plugins
 */
export interface Artifact {
  /** Capability this artifact provides */
  readonly capability: CapabilityKey
  /** Plugin that created this artifact */
  readonly plugin: string
  /** Plugin-specific data */
  readonly data: unknown
}

/**
 * Information about a PostgreSQL extension
 */
export interface ExtensionInfo {
  /** Extension name (e.g., "citext", "postgis") */
  readonly name: string
  /** Namespace OID where extension objects are installed */
  readonly namespaceOid: string
  /** Extension version */
  readonly version: string | null
}

/**
 * The complete Semantic IR
 */
export interface SemanticIR {
  /** All entities (tables, views, composites) keyed by name */
  readonly entities: ReadonlyMap<string, Entity>
  /** All enums keyed by name */
  readonly enums: ReadonlyMap<string, EnumDef>
  /** Artifacts from plugins, keyed by capability */
  readonly artifacts: ReadonlyMap<CapabilityKey, Artifact>
  /** Installed PostgreSQL extensions */
  readonly extensions: readonly ExtensionInfo[]

  // Metadata
  /** When introspection was performed */
  readonly introspectedAt: Date
  /** PostgreSQL schemas that were introspected */
  readonly schemas: readonly string[]
}

/**
 * Mutable builder for SemanticIR - used during IR construction
 */
export interface SemanticIRBuilder {
  entities: Map<string, Entity>
  enums: Map<string, EnumDef>
  artifacts: Map<CapabilityKey, Artifact>
  extensions: ExtensionInfo[]
  introspectedAt: Date
  schemas: string[]
}

/**
 * Create an empty IR builder
 */
export function createIRBuilder(schemas: readonly string[]): SemanticIRBuilder {
  return {
    entities: new Map(),
    enums: new Map(),
    artifacts: new Map(),
    extensions: [],
    introspectedAt: new Date(),
    schemas: [...schemas],
  }
}

/**
 * Freeze a builder into an immutable IR
 */
export function freezeIR(builder: SemanticIRBuilder): SemanticIR {
  return {
    entities: new Map(builder.entities),
    enums: new Map(builder.enums),
    artifacts: new Map(builder.artifacts),
    extensions: [...builder.extensions],
    introspectedAt: builder.introspectedAt,
    schemas: [...builder.schemas],
  }
}
