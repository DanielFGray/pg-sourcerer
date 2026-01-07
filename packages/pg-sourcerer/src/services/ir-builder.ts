/**
 * IR Builder Service
 *
 * Transforms raw pg-introspection output into SemanticIR.
 * Builds entities (tables, views, composites), shapes, fields,
 * relations, and enums.
 */
import { Context, Effect, Layer, pipe, Array } from "effect"
import type {
  Introspection,
  PgAttribute,
  PgClass,
  PgConstraint,
  PgType,
  PgRoles,
} from "pg-introspection"
import { entityPermissions } from "pg-introspection"
import type {
  DomainBaseTypeInfo,
  Entity,
  EnumDef,
  ExtensionInfo,
  Field,
  EntityPermissions,
  FieldPermissions,
  PrimaryKey,
  Relation,
  SemanticIR,
  Shape,
} from "../ir/semantic-ir.js"
import type { ShapeKind, SmartTags } from "../ir/smart-tags.js"
import { emptySmartTags } from "../ir/smart-tags.js"
import { createIRBuilder, freezeIR } from "../ir/semantic-ir.js"
import { Inflection } from "./inflection.js"
import { parseSmartTags, type TagContext } from "./smart-tags-parser.js"
import { IntrospectionFailed, TagParseError } from "../errors.js"

// ============================================================================
// Types
// ============================================================================

/**
 * Options for IR building
 */
export interface IRBuilderOptions {
  /** PostgreSQL schemas to include */
  readonly schemas: readonly string[]
}

/**
 * IR Builder service interface
 */
export interface IRBuilder {
  /** Build SemanticIR from pg-introspection output */
  readonly build: (
    introspection: Introspection,
    options: IRBuilderOptions
  ) => Effect.Effect<SemanticIR, IntrospectionFailed | TagParseError, Inflection>
}

/** Service tag */
export class IRBuilderSvc extends Context.Tag("IRBuilder")<IRBuilderSvc, IRBuilder>() {}

// ============================================================================
// Field Building
// ============================================================================

/**
  * Check if a shape kind should be omitted based on tags
  */
function isOmittedForShape(tags: SmartTags, kind: ShapeKind): boolean {
  if (tags.omit === true) return true
  if (globalThis.Array.isArray(tags.omit)) {
    return tags.omit.includes(kind)
  }
  return false
}

// ============================================================================
// Permissions
// ============================================================================

/**
  * Compute field permissions from column ACL or fallback to table-level permissions
  */
function computeFieldPermissions(
  introspection: Introspection,
  attr: PgAttribute,
  role: PgRoles
): FieldPermissions {
  // Get table for fallback permissions
  const pgClass = attr.getClass()

  // Get column-level permissions from ACL
  const attributePermissions = pgClass
    ? entityPermissions(introspection, attr, role)
    : undefined

  // Get table-level permissions for fallback
  const tablePermissions = pgClass
    ? entityPermissions(introspection, pgClass, role)
    : undefined

  return {
    canSelect: attributePermissions?.select ?? tablePermissions?.select ?? false,
    canInsert: attributePermissions?.insert ?? tablePermissions?.insert ?? false,
    canUpdate: attributePermissions?.update ?? tablePermissions?.update ?? false,
  }
}

/**
  * Compute entity permissions from table ACL
  */
function computeEntityPermissions(
  introspection: Introspection,
  pgClass: PgClass,
  role: PgRoles
): EntityPermissions {
  const perms = entityPermissions(introspection, pgClass, role)

  // For SELECT, INSERT, UPDATE - also check if any column has the permission
  // This handles the case where table-level ACL is null but column ACLs exist
  let canSelect = perms.select ?? false
  let canInsert = perms.insert ?? false
  let canUpdate = perms.update ?? false

  if (!canSelect || !canInsert || !canUpdate) {
    const attributes = pgClass.getAttributes().filter((a) => a.attnum > 0)
    for (const attr of attributes) {
      const attrPerms = entityPermissions(introspection, attr, role)
      canSelect ||= attrPerms.select ?? false
      canInsert ||= attrPerms.insert ?? false
      canUpdate ||= attrPerms.update ?? false
    }
  }

  return {
    canSelect,
    canInsert,
    canUpdate,
    canDelete: perms.delete ?? false,
  }
}

/**
 * Resolve domain base type information.
 * If the type is a domain (typtype === 'd'), look up the underlying base type.
 * This is needed for proper type mapping of domain types like `username` over `citext`.
 */
function resolveDomainBaseType(
  pgType: PgType | undefined,
  introspection: Introspection
): DomainBaseTypeInfo | undefined {
  if (pgType?.typtype !== "d") {
    return undefined
  }

  // Domain types have typbasetype pointing to the underlying type
  const baseTypeOid = pgType.typbasetype
  if (!baseTypeOid) {
    return undefined
  }

  // Look up the base type using introspection.getType
  const baseType = introspection.getType({ id: String(baseTypeOid) })
  if (!baseType) {
    return undefined
  }

  // If the base type is also a domain, recursively resolve it
  if (baseType.typtype === "d") {
    return resolveDomainBaseType(baseType, introspection)
  }

  return {
    typeName: baseType.typname,
    typeOid: Number(baseType._id),
    namespaceOid: String(baseType.typnamespace ?? ""),
    category: baseType.typcategory ?? "",
  }
}

/**
  * Build a Field from a PgAttribute
  */
function buildField(
  attr: PgAttribute,
  tags: SmartTags,
  kind: ShapeKind,
  introspection: Introspection,
  role: PgRoles
): Effect.Effect<Field, never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection
    const pgType = attr.getType()

    // Array handling
    const isArray = pgType?.typcategory === "A"
    const elementType = isArray ? pgType?.getElemType() : undefined

    // Determine optionality based on shape kind and column properties
    // Note: pg-introspection fields can be null, we default to false
    const hasDefault = attr.atthasdef ?? false
    const isGenerated = (attr.attgenerated ?? "") !== ""
    const isIdentity = (attr.attidentity ?? "") !== ""
    const nullable = !(attr.attnotnull ?? false)

    // In insert shape, fields with defaults are optional
    // In update shape, all fields are optional (except PKs, handled elsewhere)
    // In patch shape, all fields are optional
    // In row shape, only nullable fields are optional
    let optional: boolean
    switch (kind) {
      case "insert":
        optional = hasDefault || isGenerated || isIdentity || nullable
        break
      case "update":
        optional = true
        break
      case "patch":
        optional = true
        break
      case "row":
      default:
        optional = nullable
        break
    }

    // Compute field permissions from column ACL or fallback to table-level
    const permissions = computeFieldPermissions(introspection, attr, role)

    // Resolve domain base type for proper type mapping
    const domainBaseType = resolveDomainBaseType(pgType, introspection)

    const field: Field = {
      name: inflection.fieldName(attr, tags),
      columnName: attr.attname,
      pgAttribute: attr,
      nullable,
      optional,
      hasDefault,
      isGenerated,
      isIdentity,
      isArray,
      tags,
      extensions: new Map(),
      permissions,
    }

    // Build result with optional properties (exactOptionalPropertyTypes)
    let result = field
    if (elementType?.typname !== undefined) {
      result = { ...result, elementTypeName: elementType.typname }
    }
    if (domainBaseType !== undefined) {
      result = { ...result, domainBaseType }
    }

    return result
  })
}

/**
  * Build a Shape from attributes
  */
function buildShape(
  entityName: string,
  kind: ShapeKind,
  attributes: readonly PgAttribute[],
  attributeTags: ReadonlyMap<string, SmartTags>,
  introspection: Introspection,
  role: PgRoles
): Effect.Effect<Shape, never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection

    const filteredAttrs = pipe(
      attributes,
      Array.filter((attr) => {
        const tags = attributeTags.get(attr.attname) ?? emptySmartTags
        return !isOmittedForShape(tags, kind)
      })
    )

    const fields = yield* Effect.forEach(filteredAttrs, (attr) => {
      const tags = attributeTags.get(attr.attname) ?? emptySmartTags
      return buildField(attr, tags, kind, introspection, role)
    })

    return {
      name: inflection.shapeName(entityName, kind),
      kind,
      fields,
    }
  })
}

// ============================================================================
// Entity Building
// ============================================================================

/**
 * Determine entity kind from pg_class relkind
 */
function entityKind(relkind: string): "table" | "view" | "composite" {
  switch (relkind) {
    case "r":
      return "table"
    case "v":
    case "m": // materialized view
      return "view"
    case "c":
      return "composite"
    default:
      return "table"
  }
}

/**
 * Get primary key constraint from pgClass
 */
function getPrimaryKeyConstraint(pgClass: PgClass): PgConstraint | undefined {
  const constraints = pgClass.getConstraints()
  return constraints.find((c) => c.contype === "p")
}

/**
 * Build primary key info from pgClass
 */
function buildPrimaryKey(
  pgClass: PgClass,
  tags: SmartTags
): PrimaryKey | undefined {
  // Check for virtual PK from tags first (for views)
  if (tags.primaryKey && tags.primaryKey.length > 0) {
    return {
      columns: tags.primaryKey,
      isVirtual: true,
    }
  }

  // Get real PK constraint
  const pk = getPrimaryKeyConstraint(pgClass)
  if (!pk) return undefined

  const pkColumns = pk.getAttributes()
  if (!pkColumns || pkColumns.length === 0) return undefined

  return {
    columns: pkColumns.map((a: PgAttribute) => a.attname),
    isVirtual: false,
  }
}

/**
 * Parse all attribute tags for a class
 */
function parseAttributeTags(
  pgClass: PgClass
): Effect.Effect<ReadonlyMap<string, SmartTags>, TagParseError> {
  const attributes = pgClass.getAttributes().filter((a) => a.attnum > 0)

  return Effect.reduce(
    attributes,
    new Map<string, SmartTags>(),
    (map, attr) => {
      const context: TagContext = {
        objectType: "column",
        objectName: `${pgClass.relname}.${attr.attname}`,
      }
      return parseSmartTags(attr.getDescription(), context).pipe(
        Effect.map((parsed) => {
          map.set(attr.attname, parsed.tags)
          return map
        })
      )
    }
  )
}

/**
  * Build an Entity from a PgClass
  */
function buildEntity(
  pgClass: PgClass,
  entityNameLookup: ReadonlyMap<string, string>,
  introspection: Introspection,
  role: PgRoles
): Effect.Effect<Entity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "table",
    objectName: pgClass.relname,
  }

  return Effect.gen(function* () {
    const inflection = yield* Inflection

    // Parse table tags
    const tableParsed = yield* parseSmartTags(pgClass.getDescription(), context)
    const tableTags = tableParsed.tags

    // Parse all column tags
    const attributeTags = yield* parseAttributeTags(pgClass)

    const name = inflection.entityName(pgClass, tableTags)
    const kind = entityKind(pgClass.relkind)
    const schemaName = pgClass.getNamespace()?.nspname ?? "public"

    // Get visible attributes (attnum > 0 excludes system columns)
    const attributes = pgClass.getAttributes().filter((a) => a.attnum > 0)

    // Build shapes - now yields since buildShape returns Effect
    const rowShape = yield* buildShape(name, "row", attributes, attributeTags, introspection, role)

    // Build relations from foreign keys
    const relations = yield* buildRelations(pgClass, entityNameLookup)

    // Build primary key
    const primaryKey = buildPrimaryKey(pgClass, tableTags)

    // Compute entity permissions
    const permissions = computeEntityPermissions(introspection, pgClass, role)

    // Build shapes object conditionally to satisfy exactOptionalPropertyTypes
    const shapes: Entity["shapes"] =
      kind === "table"
        ? {
            row: rowShape,
            insert: yield* buildShape(name, "insert", attributes, attributeTags, introspection, role),
            update: yield* buildShape(name, "update", attributes, attributeTags, introspection, role),
            patch: yield* buildShape(name, "patch", attributes, attributeTags, introspection, role),
          }
        : { row: rowShape }

    // Build entity conditionally to satisfy exactOptionalPropertyTypes
    const baseEntity = {
      name,
      tableName: pgClass.relname,
      schemaName,
      kind,
      pgClass,
      shapes,
      relations,
      tags: tableTags,
      permissions,
    }

    // Only include primaryKey if defined
    const entity: Entity = primaryKey !== undefined
      ? { ...baseEntity, primaryKey }
      : baseEntity

    return entity
  })
}

// ============================================================================
// Relations
// ============================================================================

/**
 * Build relations from foreign key constraints
 */
function buildRelations(
  pgClass: PgClass,
  entityNameLookup: ReadonlyMap<string, string>
): Effect.Effect<readonly Relation[], TagParseError, Inflection> {
  const fks = pgClass.getConstraints().filter((c) => c.contype === "f")

  return Effect.forEach(fks, (fk) => buildRelation(fk, entityNameLookup))
}

/**
 * Build a single relation from a FK constraint
 */
function buildRelation(
  fk: PgConstraint,
  entityNameLookup: ReadonlyMap<string, string>
): Effect.Effect<Relation, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "constraint",
    objectName: fk.conname,
  }

  return Effect.gen(function* () {
    const inflection = yield* Inflection
    const parsed = yield* parseSmartTags(fk.getDescription(), context)
    const constraintTags = parsed.tags

    // Get the foreign table
    const foreignClass = fk.getForeignClass()
    const foreignOid = foreignClass?._id ?? ""

    // Look up the entity name for the foreign table
    const targetEntity = entityNameLookup.get(foreignOid) ?? foreignClass?.relname ?? "Unknown"

    // Get column mappings
    const localAttrs = fk.getAttributes() ?? []
    const foreignAttrs = fk.getForeignAttributes() ?? []

    const columns = localAttrs.map((local, i) => ({
      local: local.attname,
      foreign: foreignAttrs[i]?.attname ?? local.attname,
    }))

    // This is the "local" side - we have the FK, so we "belong to" the foreign table
    const name = inflection.relationName(fk, "local", constraintTags)

    return {
      name,
      kind: "belongsTo" as const,
      targetEntity,
      constraintName: fk.conname,
      columns,
      tags: constraintTags,
    }
  })
}

// ============================================================================
// Enums
// ============================================================================

/**
 * Build an EnumDef from a PgType
 */
function buildEnum(
  pgType: PgType
): Effect.Effect<EnumDef, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "type",
    objectName: pgType.typname,
  }

  return Effect.gen(function* () {
    const inflection = yield* Inflection
    const parsed = yield* parseSmartTags(pgType.getDescription(), context)
    const tags = parsed.tags
    const schemaName = pgType.getNamespace()?.nspname ?? "public"
    const values = pgType.getEnumValues()?.map((v) => v.enumlabel) ?? []

    return {
      name: inflection.enumName(pgType, tags),
      pgName: pgType.typname,
      schemaName,
      pgType,
      values,
      tags,
    }
  })
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build entity name lookup map (oid -> entity name)
 * This is needed for relation building to know target entity names
 */
function buildEntityNameLookup(
  classes: readonly PgClass[]
): Effect.Effect<ReadonlyMap<string, string>, TagParseError, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection

    return yield* Effect.reduce(classes, new Map<string, string>(), (map, pgClass) => {
      const context: TagContext = {
        objectType: "table",
        objectName: pgClass.relname,
      }

      return parseSmartTags(pgClass.getDescription(), context).pipe(
        Effect.map((parsed) => {
          const name = inflection.entityName(pgClass, parsed.tags)
          map.set(pgClass._id, name)
          return map
        })
      )
    })
  })
}

/**
 * Filter classes to include (tables and views in specified schemas)
 */
function filterClasses(
  introspection: Introspection,
  schemas: readonly string[]
): readonly PgClass[] {
  const schemaSet = new Set(schemas)

  return introspection.classes.filter((c) => {
    const namespace = c.getNamespace()?.nspname
    if (!namespace || !schemaSet.has(namespace)) return false

    // Include tables, views, materialized views
    return c.relkind === "r" || c.relkind === "v" || c.relkind === "m"
  })
}

/**
 * Filter enum types in specified schemas
 */
function filterEnums(
  introspection: Introspection,
  schemas: readonly string[]
): readonly PgType[] {
  const schemaSet = new Set(schemas)

  return introspection.types.filter((t) => {
    const namespace = t.getNamespace()?.nspname
    if (!namespace || !schemaSet.has(namespace)) return false

    return t.typtype === "e" // enum type
  })
}

/**
 * Extract extension info from introspection.
 * Extensions are needed for type mapping (e.g., citext -> string).
 */
function extractExtensions(
  introspection: Introspection
): readonly ExtensionInfo[] {
  return introspection.extensions.map((ext) => ({
    name: ext.extname,
    namespaceOid: String(ext.extnamespace ?? ""),
    version: ext.extversion,
  }))
}

/**
  * Create the live IR builder implementation
  */
function createIRBuilderImpl(): IRBuilder {
  return {
    build: (introspection, options) =>
      Effect.gen(function* () {
        const classes = filterClasses(introspection, options.schemas)
        const enumTypes = filterEnums(introspection, options.schemas)

        // Get the current role for permission checks, or use a fallback
        const role: PgRoles = introspection.getCurrentUser() ?? {
          rolname: "unknown",
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolcanlogin: false,
          rolreplication: false,
          rolconnlimit: -1,
          rolpassword: null,
          rolvaliduntil: null,
          rolbypassrls: false,
          rolconfig: null,
          _id: "0",
        }

        // Build entity name lookup first (needed for relations)
        const entityNameLookup = yield* buildEntityNameLookup(classes)

        // Build entities
        const entities = yield* Effect.forEach(classes, (pgClass) =>
          buildEntity(pgClass, entityNameLookup, introspection, role)
        )

        // Build enums
        const enums = yield* Effect.forEach(enumTypes, (pgType) =>
          buildEnum(pgType)
        )

        // Extract extensions for type mapping
        const extensions = extractExtensions(introspection)

        // Assemble IR
        const builder = createIRBuilder(options.schemas)
        for (const entity of entities) {
          builder.entities.set(entity.name, entity)
        }
        for (const enumDef of enums) {
          builder.enums.set(enumDef.name, enumDef)
        }
        builder.extensions.push(...extensions)

        return freezeIR(builder)
      }),
  }
}

// ============================================================================
// Layers
// ============================================================================

/**
 * Live layer - provides IRBuilder service
 * Note: IRBuilder.build() requires Inflection to be provided at call time
 */
export const IRBuilderLive = Layer.succeed(IRBuilderSvc, createIRBuilderImpl())

/**
 * Factory function for creating IR builder
 * Note: The returned builder's build() method requires Inflection in the Effect context
 */
export function createIRBuilderService(): IRBuilder {
  return createIRBuilderImpl()
}
