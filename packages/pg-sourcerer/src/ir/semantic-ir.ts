/**
 * Semantic IR - Intermediate Representation of database schema
 *
 * This is the core data structure that plugins consume.
 * It represents semantic intent, not code.
 */
import type { PgAttribute, PgClass, PgType, PgProc } from "@danielfgray/pg-introspection";
import type { SmartTags, ShapeKind } from "./smart-tags.js";

/**
 * Information about a domain type's underlying base type.
 * Used for type resolution when the column type is a domain.
 */
export interface DomainBaseTypeInfo {
  /** Base type name (e.g., "citext" for a domain over citext) */
  readonly typeName: string;
  /** Base type OID (for OID-based type mapping) */
  readonly typeOid: number;
  /** Base type namespace OID (for extension lookup) */
  readonly namespaceOid: string;
  /** Base type category (e.g., 'S' for string) */
  readonly category: string;
}

/**
 * A field within a shape - represents a column with semantic context
 */
export interface Field {
  /** Inflected field name (camelCase) */
  readonly name: string;
  /** Original PostgreSQL column name */
  readonly columnName: string;
  /** Raw attribute from pg-introspection */
  readonly pgAttribute: PgAttribute;

  // Semantic properties (derived from pgAttribute for convenience)
  /** Can be NULL at runtime */
  readonly nullable: boolean;
  /** Optional in this shape (e.g., has default for insert) */
  readonly optional: boolean;
  /** Has DEFAULT or is GENERATED */
  readonly hasDefault: boolean;
  /** GENERATED ALWAYS column */
  readonly isGenerated: boolean;
  /** IDENTITY column */
  readonly isIdentity: boolean;

  // Array handling
  /** PostgreSQL array type */
  readonly isArray: boolean;
  /** For arrays, the element type name */
  readonly elementTypeName?: string;

  // Domain type handling
  /** If the column type is a domain, info about the underlying base type */
  readonly domainBaseType?: DomainBaseTypeInfo;

  /** Smart tags from comment */
  readonly tags: SmartTags;

  /** Plugin-attached data (extensible, keyed by plugin name) */
  readonly extensions: ReadonlyMap<string, unknown>;

  /** Permissions for the connected role */
  readonly permissions: FieldPermissions;
}

/**
 * A shape is a structure with fields - the semantic description
 * that can become a TypeScript type, Zod schema, etc.
 */
export interface Shape {
  /** e.g., "UserRow", "UserInsert" */
  readonly name: string;
  /** The kind of shape */
  readonly kind: ShapeKind;
  /** Fields in this shape */
  readonly fields: readonly Field[];
}

/**
 * Relation between entities - inferred from foreign key constraints.
 * Contains raw constraint data; plugins derive names as needed.
 */
export interface Relation {
  /** Relationship kind */
  readonly kind: "hasMany" | "hasOne" | "belongsTo";
  /** Target entity name (not table name) */
  readonly targetEntity: string;
  /** Original FK constraint name */
  readonly constraintName: string;

  /** Column mappings (supports composite FKs) */
  readonly columns: readonly {
    readonly local: string;
    readonly foreign: string;
  }[];

  /** Smart tags from constraint comment */
  readonly tags: SmartTags;
}

/**
 * Primary key information
 */
export interface PrimaryKey {
  /** Column names in the primary key */
  readonly columns: readonly string[];
  /** True if from @primaryKey tag, false if real PK constraint */
  readonly isVirtual: boolean;
}

/**
 * Index method types
 */
export type IndexMethod = "btree" | "gin" | "gist" | "hash" | "brin" | "spgist";

/**
 * Function volatility classification - affects query optimization and caching
 */
export type Volatility = "immutable" | "stable" | "volatile";

/**
 * Information about a database index
 */
export interface IndexDef {
  /** PostgreSQL index name */
  readonly name: string;
  /** Inflected column names (camelCase) */
  readonly columns: readonly string[];
  /** Original PostgreSQL column names */
  readonly columnNames: readonly string[];
  /** True if this is a unique index */
  readonly isUnique: boolean;
  /** True if this is a primary key index */
  readonly isPrimary: boolean;
  /** True if this is a partial index (has WHERE clause) */
  readonly isPartial: boolean;
  /** WHERE clause for partial indexes (raw SQL) */
  readonly predicate?: string;
  /** Index method (btree, gin, gist, hash, brin, spgist) */
  readonly method: IndexMethod;
  /** True if any "column" is actually an expression (not a real column) */
  readonly hasExpressions: boolean;
  /** Operator class names for each indexed column (e.g., "gin_trgm_ops", "tsvector_ops") */
  readonly opclassNames: readonly string[];
}

/**
 * Permissions for a field (column) based on connected role's ACLs
 */
export interface FieldPermissions {
  /** Column can be selected */
  readonly canSelect: boolean;
  /** Column can be used in INSERT */
  readonly canInsert: boolean;
  /** Column can be used in UPDATE */
  readonly canUpdate: boolean;
}

/**
 * Permissions for an entity (table/view) based on connected role's ACLs
 */
export interface EntityPermissions {
  /** Table can be selected from */
  readonly canSelect: boolean;
  /** Rows can be inserted */
  readonly canInsert: boolean;
  /** Rows can be updated */
  readonly canUpdate: boolean;
  /** Rows can be deleted */
  readonly canDelete: boolean;
}

// ============================================================================
// Entity Kind Discriminator
// ============================================================================

/**
 * All possible entity kinds
 */
export type EntityKind = "table" | "view" | "enum" | "domain" | "composite" | "function";

// ============================================================================
// Entity Base (shared fields)
// ============================================================================

/**
 * Base fields shared by all entity kinds
 */
interface EntityBase {
  /** Inflected entity name (PascalCase) */
  readonly name: string;
  /** Original PostgreSQL object name (table, view, or type name) */
  readonly pgName: string;
  /** PostgreSQL schema name */
  readonly schemaName: string;
  /** Smart tags from comment */
  readonly tags: SmartTags;
}

// ============================================================================
// Table/View Entity
// ============================================================================

/**
 * A table or view entity - has shapes, relations, and permissions
 */
export interface TableEntity extends EntityBase {
  /** Entity kind discriminator */
  readonly kind: "table" | "view";
  /** Raw class from pg-introspection */
  readonly pgClass: PgClass;

  /** Primary key (may be undefined for views without @primaryKey) */
  readonly primaryKey?: PrimaryKey;

  /** Indexes on this entity */
  readonly indexes: readonly IndexDef[];

  /** Shapes for this entity */
  readonly shapes: {
    /** Base shape (row) - always present */
    readonly row: Shape;
    /** Insert shape - only if different from base */
    readonly insert?: Shape;
    /** Update shape - only if different from insert (or base) */
    readonly update?: Shape;
  };

  /** Relations to other entities */
  readonly relations: readonly Relation[];

  /** Permissions for the connected role */
  readonly permissions: EntityPermissions;
}

// ============================================================================
// Enum Entity
// ============================================================================

/**
 * An enum entity - represents a PostgreSQL enum type
 */
export interface EnumEntity extends EntityBase {
  /** Entity kind discriminator */
  readonly kind: "enum";
  /** Raw type from pg-introspection */
  readonly pgType: PgType;
  /** Enum values in order */
  readonly values: readonly string[];
}

// ============================================================================
// Domain Entity
// ============================================================================

/**
 * A CHECK constraint on a domain type
 */
export interface DomainConstraint {
  /** Constraint name */
  readonly name: string;
  /** Raw constraint expression (from pg_constraint.conbin decompiled) */
  readonly expression?: string;
}

/**
 * A domain entity - represents a PostgreSQL domain type (constrained wrapper over a base type)
 */
export interface DomainEntity extends EntityBase {
  /** Entity kind discriminator */
  readonly kind: "domain";
  /** Raw type from pg-introspection */
  readonly pgType: PgType;
  /** Name of the underlying base type (e.g., "citext", "text") */
  readonly baseTypeName: string;
  /** OID of the base type (for type mapping) */
  readonly baseTypeOid: number;
  /** Whether the domain has a NOT NULL constraint */
  readonly notNull: boolean;
  /** Domain CHECK constraints */
  readonly constraints: readonly DomainConstraint[];
}

// ============================================================================
// Composite Entity
// ============================================================================

/**
 * A composite entity - represents a user-defined PostgreSQL composite type
 *
 * Note: Table row types (auto-generated composites with typrelid != 0) are NOT included.
 * Only explicitly created composite types are represented here.
 */
export interface CompositeEntity extends EntityBase {
  /** Entity kind discriminator */
  readonly kind: "composite";
  /** Raw type from pg-introspection */
  readonly pgType: PgType;
  /** Fields in the composite type (reuses Field interface) */
  readonly fields: readonly Field[];
}

// ============================================================================
// Function Entity
// ============================================================================

export interface FunctionArg {
  readonly name: string;
  readonly typeName: string;
  readonly hasDefault: boolean;
}

/**
 * A function entity - represents a PostgreSQL stored function
 *
 * Note: Only supports normal functions with IN parameters.
 * Functions with OUT/INOUT parameters or RETURNS TABLE are not supported.
 */
export interface FunctionEntity extends EntityBase {
  /** Entity kind discriminator */
  readonly kind: "function";
  /** Raw proc from pg-introspection */
  readonly pgProc: PgProc;
  /** Return type name (e.g., "text", "pg_catalog.int4") */
  readonly returnTypeName: string;
  /** True if function returns SETOF */
  readonly returnsSet: boolean;
  /** Number of arguments (for overload disambiguation) */
  readonly argCount: number;
  /** Function arguments */
  readonly args: readonly FunctionArg[];
  /** Volatility classification */
  readonly volatility: Volatility;
  /** True if function is STRICT (NULL input = NULL output) */
  readonly isStrict: boolean;
  /** Whether the current role can execute this function */
  readonly canExecute: boolean;
  /** True if function belongs to an installed extension */
  readonly isFromExtension: boolean;
}

// ============================================================================
// Unified Entity Type
// ============================================================================

/**
 * An entity represents a table, view, enum, domain, or composite type in the database.
 *
 * Use the `kind` discriminator to narrow the type:
 * ```typescript
 * if (entity.kind === "enum") {
 *   // entity is EnumEntity, has .values
 * } else if (entity.kind === "domain") {
 *   // entity is DomainEntity, has .baseTypeName, .constraints
 * } else if (entity.kind === "composite") {
 *   // entity is CompositeEntity, has .fields
 * } else {
 *   // entity is TableEntity, has .shapes, .relations, etc.
 * }
 * ```
 */
export type Entity = TableEntity | EnumEntity | DomainEntity | CompositeEntity | FunctionEntity;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an entity is a table or view (has shapes, relations, etc.)
 */
export function isTableEntity(entity: Entity): entity is TableEntity {
  return entity.kind === "table" || entity.kind === "view";
}

/**
 * Check if an entity is an enum (has values)
 */
export function isEnumEntity(entity: Entity): entity is EnumEntity {
  return entity.kind === "enum";
}

/**
 * Check if an entity is a domain (has baseTypeName, constraints)
 */
export function isDomainEntity(entity: Entity): entity is DomainEntity {
  return entity.kind === "domain";
}

/**
 * Check if an entity is a composite type (has fields)
 */
export function isCompositeEntity(entity: Entity): entity is CompositeEntity {
  return entity.kind === "composite";
}

/**
 * Check if an entity is a function (has args, volatility, etc.)
 */
export function isFunctionEntity(entity: Entity): entity is FunctionEntity {
  return entity.kind === "function";
}

// ============================================================================
// Other Types
// ============================================================================

/**
 * Capability key - colon-separated hierarchical namespace
 * e.g., "types", "schemas", "schemas:zod", "queries:crud"
 */
export type CapabilityKey = string;

/**
 * Artifact - plugin output stored in IR for downstream plugins
 */
export interface Artifact {
  /** Capability this artifact provides */
  readonly capability: CapabilityKey;
  /** Plugin that created this artifact */
  readonly plugin: string;
  /** Plugin-specific data */
  readonly data: unknown;
}

/**
 * Information about a PostgreSQL extension
 */
export interface ExtensionInfo {
  /** Extension name (e.g., "citext", "postgis") */
  readonly name: string;
  /** Namespace OID where extension objects are installed */
  readonly namespaceOid: string;
  /** Extension version */
  readonly version: string | null;
}

/**
 * The complete Semantic IR
 */
export interface SemanticIR {
  /** All entities (tables, views, enums) keyed by name */
  readonly entities: ReadonlyMap<string, Entity>;
  /** Artifacts from plugins, keyed by capability */
  readonly artifacts: ReadonlyMap<CapabilityKey, Artifact>;
  /** Installed PostgreSQL extensions */
  readonly extensions: readonly ExtensionInfo[];

  // Metadata
  /** When introspection was performed */
  readonly introspectedAt: Date;
  /** PostgreSQL schemas that were introspected */
  readonly schemas: readonly string[];
}

/**
 * Mutable builder for SemanticIR - used during IR construction
 */
export interface SemanticIRBuilder {
  entities: Map<string, Entity>;
  artifacts: Map<CapabilityKey, Artifact>;
  extensions: ExtensionInfo[];
  introspectedAt: Date;
  schemas: string[];
}

/**
 * Create an empty IR builder
 */
export function createIRBuilder(schemas: readonly string[]): SemanticIRBuilder {
  return {
    entities: new Map(),
    artifacts: new Map(),
    extensions: [],
    introspectedAt: new Date(),
    schemas: [...schemas],
  };
}

/**
 * Freeze a builder into an immutable IR
 */
export function freezeIR(builder: SemanticIRBuilder): SemanticIR {
  return {
    entities: new Map(builder.entities),
    artifacts: new Map(builder.artifacts),
    extensions: [...builder.extensions],
    introspectedAt: builder.introspectedAt,
    schemas: [...builder.schemas],
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get all table/view entities from the IR
 */
export function getTableEntities(ir: SemanticIR): TableEntity[] {
  return [...ir.entities.values()].filter(isTableEntity);
}

/**
 * Get all enum entities from the IR
 */
export function getEnumEntities(ir: SemanticIR): EnumEntity[] {
  return [...ir.entities.values()].filter(isEnumEntity);
}

/**
 * Get all domain entities from the IR
 */
export function getDomainEntities(ir: SemanticIR): DomainEntity[] {
  return [...ir.entities.values()].filter(isDomainEntity);
}

/**
 * Get all composite entities from the IR
 */
export function getCompositeEntities(ir: SemanticIR): CompositeEntity[] {
  return [...ir.entities.values()].filter(isCompositeEntity);
}

/**
 * Get all function entities from the IR
 */
export function getFunctionEntities(ir: SemanticIR): FunctionEntity[] {
  return [...ir.entities.values()].filter(isFunctionEntity);
}

// ============================================================================
// Reverse Relations (hasMany/hasOne from belongsTo)
// ============================================================================

/**
 * A reversed relation - represents the "other side" of a belongsTo FK.
 *
 * If orders.user_id → users.id creates a "orders belongsTo users" relation,
 * the reverse is "users hasMany orders".
 */
export interface ReverseRelation {
  /** The kind of reverse relationship */
  readonly kind: "hasMany" | "hasOne";
  /** Entity name that has the FK (the "child" table) */
  readonly sourceEntity: string;
  /** Original constraint name */
  readonly constraintName: string;
  /** Column mappings (same as original, but semantically reversed) */
  readonly columns: readonly {
    /** Column on the target (this) entity - the referenced column */
    readonly local: string;
    /** Column on the source entity - the FK column */
    readonly foreign: string;
  }[];
  /** Original relation this was derived from */
  readonly originalRelation: Relation;
}

/**
 * Get all reverse relations pointing TO this entity.
 *
 * Scans all entities for belongsTo relations targeting the given entity
 * and returns them as hasMany relations.
 *
 * @example
 * ```typescript
 * // If orders.user_id → users.id exists as "orders belongsTo users"
 * const reverseRels = getReverseRelations(ir, "User")
 * // Returns: [{ kind: "hasMany", sourceEntity: "Order", ... }]
 * ```
 */
export function getReverseRelations(
  ir: SemanticIR,
  entityName: string,
): readonly ReverseRelation[] {
  const results: ReverseRelation[] = [];

  for (const entity of ir.entities.values()) {
    if (!isTableEntity(entity)) continue;

    for (const relation of entity.relations) {
      if (relation.targetEntity === entityName && relation.kind === "belongsTo") {
        results.push({
          // Default to hasMany; could be hasOne if unique constraint on FK
          // TODO: detect unique constraint on FK columns for hasOne
          kind: "hasMany",
          sourceEntity: entity.name,
          constraintName: relation.constraintName,
          // Swap local/foreign perspective
          columns: relation.columns.map(col => ({
            local: col.foreign, // Referenced column becomes "local"
            foreign: col.local, // FK column becomes "foreign"
          })),
          originalRelation: relation,
        });
      }
    }
  }

  return results;
}

/**
 * Get all relations for an entity in both directions.
 *
 * Combines the entity's direct relations (belongsTo) with reverse relations
 * (hasMany) from other entities pointing to this one.
 */
export interface AllRelations {
  /** Direct relations from this entity (belongsTo) */
  readonly belongsTo: readonly Relation[];
  /** Reverse relations to this entity (hasMany) */
  readonly hasMany: readonly ReverseRelation[];
}

export function getAllRelations(ir: SemanticIR, entityName: string): AllRelations | undefined {
  const entity = ir.entities.get(entityName);
  if (!entity || !isTableEntity(entity)) return undefined;

  return {
    belongsTo: entity.relations.filter(r => r.kind === "belongsTo"),
    hasMany: getReverseRelations(ir, entityName),
  };
}
