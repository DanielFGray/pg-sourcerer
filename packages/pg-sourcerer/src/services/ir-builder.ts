/**
 * IR Builder Service
 *
 * Transforms raw pg-introspection output into SemanticIR.
 * Builds entities (tables, views, composites), shapes, fields,
 * relations, and enums.
 */
import { Context, Effect, Layer, pipe, Array as Arr, Option, Console } from "effect";
import type {
  Introspection,
  PgAttribute,
  PgClass,
  PgConstraint,
  PgType,
  PgProc,
  PgRoles,
} from "@danielfgray/pg-introspection";
import { entityPermissions } from "@danielfgray/pg-introspection";
import type {
  DomainBaseTypeInfo,
  TableEntity,
  EnumEntity,
  DomainEntity,
  DomainConstraint,
  CompositeEntity,
  ExtensionInfo,
  Field,
  EntityPermissions,
  FieldPermissions,
  IndexDef,
  IndexSortOption,
  PrimaryKey,
  Relation,
  SemanticIR,
  Shape,
  FunctionEntity,
  FunctionArg,
  Volatility,
} from "../ir/semantic-ir.js";
import type { ShapeKind, SmartTags } from "../ir/smart-tags.js";
import { createIRBuilder, freezeIR } from "../ir/semantic-ir.js";
import { Inflection } from "./inflection.js";
import { parseSmartTags, type TagContext } from "./smart-tags-parser.js";
import { IntrospectionFailed, TagParseError } from "../errors.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for IR building
 */
export interface IRBuilderOptions {
  /** PostgreSQL schemas to include */
  readonly schemas: readonly string[];
  /** Exclude functions that belong to extensions (default: true) */
  readonly excludeExtensionFunctions?: boolean;
  /** Role to use for permission checks (defaults to current user) */
  readonly role?: string;
}

/**
 * IR Builder service interface
 */
export interface IRBuilder {
  /** Build SemanticIR from pg-introspection output */
  readonly build: (
    introspection: Introspection,
    options: IRBuilderOptions,
  ) => Effect.Effect<SemanticIR, IntrospectionFailed | TagParseError, Inflection>;
}

/** Service tag */
export class IRBuilderSvc extends Context.Tag("IRBuilder")<IRBuilderSvc, IRBuilder>() {}

// ============================================================================
// Shape Comparison
// ============================================================================

/**
 * Compare two shapes for structural equality.
 * Shapes are equal if they have the same fields with the same optionality.
 * We compare by field name and optional flag since that's what differs between shapes.
 */
function shapesEqual(a: Shape, b: Shape): boolean {
  if (a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) {
    const fieldA = a.fields[i];
    const fieldB = b.fields[i];
    if (fieldA === undefined || fieldB === undefined) return false;
    if (fieldA.name !== fieldB.name || fieldA.optional !== fieldB.optional) return false;
  }
  return true;
}

// ============================================================================
// Field Building
// ============================================================================

/**
 * Check if a shape kind should be omitted based on tags
 */
function isOmittedForShape(tags: SmartTags, kind: ShapeKind): boolean {
  if (tags.omit === true) return true;
  if (Array.isArray(tags.omit)) {
    return tags.omit.includes(kind);
  }
  return false;
}

// ============================================================================
// Permissions
// ============================================================================

/**
 * Compute field permissions from column ACL or fallback to table-level permissions.
 *
 * PostgreSQL ACL semantics:
 * - If a column has explicit ACL (attacl is not null), column permissions ADD to table permissions
 * - If a column has no explicit ACL (attacl is null), inherit from table-level permissions
 *
 * Column-level grants add to table-level grants (they don't replace them).
 * For example: table SELECT + column UPDATE = both SELECT and UPDATE allowed.
 */
function computeFieldPermissions(
  introspection: Introspection,
  attr: PgAttribute,
  role: PgRoles,
): FieldPermissions {
  const pgClass = attr.getClass();
  if (!pgClass) {
    return { canSelect: false, canInsert: false, canUpdate: false };
  }

  // Get table-level permissions (always needed)
  const tablePerms = entityPermissions(introspection, pgClass, role);

  // Check if column has explicit ACL
  const hasExplicitColumnAcl = attr.attacl != null && attr.attacl.length > 0;

  if (!hasExplicitColumnAcl) {
    // No column-level ACL, use table permissions only
    return {
      canSelect: tablePerms.select ?? false,
      canInsert: tablePerms.insert ?? false,
      canUpdate: tablePerms.update ?? false,
    };
  }

  // Column has explicit ACL - combine with table permissions (OR semantics)
  const columnPerms = entityPermissions(introspection, attr, role);

  return {
    canSelect: (columnPerms.select ?? false) || (tablePerms.select ?? false),
    canInsert: (columnPerms.insert ?? false) || (tablePerms.insert ?? false),
    canUpdate: (columnPerms.update ?? false) || (tablePerms.update ?? false),
  };
}

/**
 * Compute entity permissions from table ACL
 */
function computeEntityPermissions(
  introspection: Introspection,
  pgClass: PgClass,
  role: PgRoles,
): EntityPermissions {
  const perms = entityPermissions(introspection, pgClass, role);

  // For SELECT, INSERT, UPDATE - also check if any column has the permission
  // This handles the case where table-level ACL is null but column ACLs exist
  const basePerms = {
    canSelect: perms.select ?? false,
    canInsert: perms.insert ?? false,
    canUpdate: perms.update ?? false,
  };

  const attributes = pgClass.getAttributes().filter(a => a.attnum > 0);
  const columnPerms = Arr.reduce(attributes, basePerms, (acc, attr) => {
    if (acc.canSelect && acc.canInsert && acc.canUpdate) {
      return acc; // Already have all permissions
    }
    const attrPerms = entityPermissions(introspection, attr, role);
    return {
      canSelect: acc.canSelect || (attrPerms.select ?? false),
      canInsert: acc.canInsert || (attrPerms.insert ?? false),
      canUpdate: acc.canUpdate || (attrPerms.update ?? false),
    };
  });

  return {
    ...columnPerms,
    canDelete: perms.delete ?? false,
  };
}

/**
 * Resolve domain base type information.
 * If the type is a domain (typtype === 'd'), look up the underlying base type.
 * This is needed for proper type mapping of domain types like `username` over `citext`.
 */
function resolveDomainBaseType(
  pgType: PgType | undefined,
  introspection: Introspection,
): DomainBaseTypeInfo | undefined {
  return pipe(
    Option.fromNullable(pgType),
    Option.filter(t => t.typtype === "d"),
    Option.flatMap(t => Option.fromNullable(t.typbasetype)),
    Option.flatMap(baseTypeOid =>
      Option.fromNullable(introspection.getType({ id: String(baseTypeOid) })),
    ),
    Option.flatMap(baseType => {
      // If the base type is also a domain, recursively resolve it
      if (baseType.typtype === "d") {
        return Option.fromNullable(resolveDomainBaseType(baseType, introspection));
      }
      return Option.some<DomainBaseTypeInfo>({
        typeName: baseType.typname,
        typeOid: Number(baseType._id),
        namespaceOid: String(baseType.typnamespace ?? ""),
        category: baseType.typcategory ?? "",
      });
    }),
    Option.getOrUndefined,
  );
}

/**
 * Build a Field from a PgAttribute
 */
function buildField(
  attr: PgAttribute,
  tags: SmartTags,
  kind: ShapeKind,
  introspection: Introspection,
  role: PgRoles,
): Effect.Effect<Field, never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const pgType = attr.getType();

    // Array handling
    const isArray = pgType?.typcategory === "A";
    const elementType = isArray ? pgType?.getElemType() : undefined;

    // Determine optionality based on shape kind and column properties
    // Note: pg-introspection fields can be null, we default to false
    const hasDefault = attr.atthasdef ?? false;
    const isGenerated = (attr.attgenerated ?? "") !== "";
    const isIdentity = (attr.attidentity ?? "") !== "";
    const nullable = !(attr.attnotnull ?? false);

    // In insert shape, fields with defaults are optional
    // In update shape, all fields are optional
    // In row shape, only nullable fields are optional
    let optional: boolean;
    switch (kind) {
      case "insert":
        optional = hasDefault || isGenerated || isIdentity || nullable;
        break;
      case "update":
        optional = true;
        break;
      case "row":
      default:
        optional = nullable;
        break;
    }

    // Compute field permissions from column ACL or fallback to table-level
    const permissions = computeFieldPermissions(introspection, attr, role);

    // Resolve domain base type for proper type mapping
    const domainBaseType = resolveDomainBaseType(pgType, introspection);

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
    };

    // Build result with optional properties (exactOptionalPropertyTypes)
    let result = field;
    if (elementType?.typname !== undefined) {
      result = { ...result, elementTypeName: elementType.typname };
    }
    if (domainBaseType !== undefined) {
      result = { ...result, domainBaseType };
    }

    return result;
  });
}

/**
 * Check if a field has the required permission for the given shape kind.
 * - row shape requires canSelect
 * - insert shape requires canInsert
 * - update shape requires canUpdate
 */
function hasPermissionForShape(permissions: FieldPermissions, kind: ShapeKind): boolean {
  switch (kind) {
    case "row":
      return permissions.canSelect;
    case "insert":
      return permissions.canInsert;
    case "update":
      return permissions.canUpdate;
    default:
      return true;
  }
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
  role: PgRoles,
): Effect.Effect<Shape, never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection;

    const filteredAttrs = pipe(
      attributes,
      Arr.filter(attr => {
        const tags = attributeTags.get(attr.attname) ?? {};
        // Filter by @omit tags
        if (isOmittedForShape(tags, kind)) return false;
        // Filter by permissions - only include fields the role can access for this shape kind
        const permissions = computeFieldPermissions(introspection, attr, role);
        return hasPermissionForShape(permissions, kind);
      }),
    );

    const fields = yield* Effect.forEach(filteredAttrs, attr => {
      const tags = attributeTags.get(attr.attname) ?? {};
      return buildField(attr, tags, kind, introspection, role);
    });

    return {
      name: inflection.shapeName(entityName, kind),
      kind,
      fields,
    };
  });
}

// ============================================================================
// Entity Building
// ============================================================================

/**
 * Determine entity kind from pg_class relkind
 */
function entityKind(relkind: string): "table" | "view" {
  switch (relkind) {
    case "r":
      return "table";
    case "v":
    case "m": // materialized view
      return "view";
    default:
      return "table";
  }
}

/**
 * Get primary key constraint from pgClass
 */
function getPrimaryKeyConstraint(pgClass: PgClass): PgConstraint | undefined {
  return pipe(
    pgClass.getConstraints(),
    Arr.findFirst(c => c.contype === "p"),
    Option.getOrUndefined,
  );
}

/**
 * Build primary key info from pgClass
 */
function buildPrimaryKey(pgClass: PgClass, tags: SmartTags): PrimaryKey | undefined {
  // Check for virtual PK from tags first (for views)
  if (tags.primaryKey && tags.primaryKey.length > 0) {
    return {
      columns: tags.primaryKey,
      isVirtual: true,
    };
  }

  // Get real PK constraint
  const pk = getPrimaryKeyConstraint(pgClass);
  if (!pk) return undefined;

  const pkColumns = pk.getAttributes();
  if (!pkColumns || pkColumns.length === 0) return undefined;

  return {
    columns: pkColumns.map((a: PgAttribute) => a.attname),
    isVirtual: false,
  };
}

/**
 * Parse all attribute tags for a class
 */
function parseAttributeTags(
  pgClass: PgClass,
): Effect.Effect<ReadonlyMap<string, SmartTags>, TagParseError> {
  const attributes = pgClass.getAttributes().filter(a => a.attnum > 0);

  return Effect.reduce(attributes, new Map<string, SmartTags>(), (map, attr) => {
    const context: TagContext = {
      objectType: "column",
      objectName: `${pgClass.relname}.${attr.attname}`,
    };
    return parseSmartTags(attr.getDescription(), context).pipe(
      Effect.map(parsed => {
        map.set(attr.attname, parsed.tags);
        return map;
      }),
    );
  });
}

/**
 * Build a TableEntity from a PgClass
 */
function buildEntity(
  pgClass: PgClass,
  entityNameLookup: ReadonlyMap<string, string>,
  introspection: Introspection,
  role: PgRoles,
): Effect.Effect<TableEntity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "table",
    objectName: pgClass.relname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;

    // Parse table tags
    const tableParsed = yield* parseSmartTags(pgClass.getDescription(), context);
    const tableTags = tableParsed.tags;

    // Parse all column tags
    const attributeTags = yield* parseAttributeTags(pgClass);

    const name = inflection.entityName(pgClass, tableTags);
    const kind = entityKind(pgClass.relkind);
    const schemaName = pgClass.getNamespace()?.nspname ?? "public";

    // Get visible attributes (attnum > 0 excludes system columns)
    const attributes = pgClass.getAttributes().filter(a => a.attnum > 0);

    // Build shapes - now yields since buildShape returns Effect
    const rowShape = yield* buildShape(name, "row", attributes, attributeTags, introspection, role);

    // Build relations from foreign keys
    const relations = yield* buildRelations(pgClass, entityNameLookup);

    // Build indexes
    const indexes = yield* buildIndexes(pgClass);

    // Build primary key
    const primaryKey = buildPrimaryKey(pgClass, tableTags);

    // Compute entity permissions
    const permissions = computeEntityPermissions(introspection, pgClass, role);

    // Build shapes object conditionally:
    // - Views only get row shape
    // - Tables get insert/update only if:
    //   1. They have fields (role has permission)
    //   2. They're structurally different from previous shape
    // - Patch is always identical to update (both have all fields optional), so we never emit it
    let shapes: TableEntity["shapes"];
    if (kind === "table") {
      const insertShape = yield* buildShape(
        name,
        "insert",
        attributes,
        attributeTags,
        introspection,
        role,
      );
      const updateShape = yield* buildShape(
        name,
        "update",
        attributes,
        attributeTags,
        introspection,
        role,
      );

      // Only include insert if it has fields and is different from row
      const includeInsert = insertShape.fields.length > 0 && !shapesEqual(rowShape, insertShape);
      // Only include update if it has fields and is different from insert (or row if insert not included)
      const includeUpdate =
        updateShape.fields.length > 0 &&
        (includeInsert
          ? !shapesEqual(insertShape, updateShape)
          : !shapesEqual(rowShape, updateShape));

      if (includeInsert && includeUpdate) {
        shapes = { row: rowShape, insert: insertShape, update: updateShape };
      } else if (includeInsert) {
        shapes = { row: rowShape, insert: insertShape };
      } else if (includeUpdate) {
        shapes = { row: rowShape, update: updateShape };
      } else {
        shapes = { row: rowShape };
      }
    } else {
      shapes = { row: rowShape };
    }

    // Build entity conditionally to satisfy exactOptionalPropertyTypes
    const baseEntity = {
      name,
      pgName: pgClass.relname,
      schemaName,
      kind,
      pgClass,
      shapes,
      relations,
      indexes,
      tags: tableTags,
      permissions,
    };

    // Only include primaryKey if defined
    const entity: TableEntity =
      primaryKey !== undefined ? { ...baseEntity, primaryKey } : baseEntity;

    return entity;
  });
}

// ============================================================================
// Relations
// ============================================================================

/**
 * Build relations from foreign key constraints
 */
function buildRelations(
  pgClass: PgClass,
  entityNameLookup: ReadonlyMap<string, string>,
): Effect.Effect<readonly Relation[], TagParseError, Inflection> {
  const fks = pgClass.getConstraints().filter(c => c.contype === "f");

  return Effect.forEach(fks, fk => buildRelation(fk, entityNameLookup));
}

/**
 * Build a single relation from a FK constraint
 */
function buildRelation(
  fk: PgConstraint,
  entityNameLookup: ReadonlyMap<string, string>,
): Effect.Effect<Relation, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "constraint",
    objectName: fk.conname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const parsed = yield* parseSmartTags(fk.getDescription(), context);
    const constraintTags = parsed.tags;

    // Get the foreign table
    const foreignClass = fk.getForeignClass();
    const foreignOid = foreignClass?._id ?? "";

    // Look up the entity name for the foreign table
    const targetEntity = entityNameLookup.get(foreignOid) ?? foreignClass?.relname ?? "Unknown";

    // Get column mappings
    const localAttrs = fk.getAttributes() ?? [];
    const foreignAttrs = fk.getForeignAttributes() ?? [];

    const columns = localAttrs.map((local, i) => ({
      local: local.attname,
      foreign: foreignAttrs[i]?.attname ?? local.attname,
    }));

    // This is the "local" side - we have the FK, so we "belong to" the foreign table
    return {
      kind: "belongsTo" as const,
      targetEntity,
      constraintName: fk.conname,
      columns,
      tags: constraintTags,
    };
  });
}

// ============================================================================
// Indexes
// ============================================================================

/**
 * Get the index method from the index class's access method
 */
function getIndexMethod(pgClass: PgClass): IndexDef["method"] {
  const accessMethod = pgClass.getAccessMethod();
  if (!accessMethod || !accessMethod.amname) {
    return "btree"; // Default to btree if unknown
  }

  // Map common access method names to our IndexMethod type
  const methodName = accessMethod.amname.toLowerCase();
  switch (methodName) {
    case "btree":
    case "gin":
    case "gist":
    case "hash":
    case "brin":
    case "spgist":
      return methodName as IndexDef["method"];
    default:
      return "btree";
  }
}

/**
 * Build IndexDef objects from pg-introspection indexes
 */
function buildIndexes(pgClass: PgClass): Effect.Effect<readonly IndexDef[], never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection;

    const indexes = pgClass.getIndexes();

    return indexes.map(index => {
      const indexClass = index.getIndexClass();
      const keys = index.getKeys();

      // Check for expressions (null entries in keys array)
      const hasExpressions = keys.some(k => k === null);

      // Get column names (filter out nulls for expression columns)
      const columnAttrs = keys.filter((k): k is PgAttribute => k !== null);
      const columns = columnAttrs.map(attr => inflection.fieldName(attr, {}));
      const columnNames = columnAttrs.map(attr => attr.attname);

      // Determine if this is a primary key index (via constraint)
      const isPrimary = index.indisprimary === true;

      // Parse indoption for sort direction per column
      // Bit 0x01 = descending, Bit 0x02 = nulls first
      const sortOptions: IndexSortOption[] = (index.indoption ?? []).map(opt => ({
        desc: (opt & 1) === 1,
        nullsFirst: (opt & 2) === 2,
      }));

      // Build the base index definition
      const indexDef: IndexDef = {
        name: indexClass?.relname ?? "unknown",
        columns,
        columnNames,
        isUnique: index.indisunique === true,
        isPrimary,
        isPartial: index.indpred !== null && index.indpred.length > 0,
        method: indexClass ? getIndexMethod(indexClass) : "btree",
        hasExpressions,
        opclassNames: index.indclassnames ?? [],
        sortOptions,
      };

      // Add predicate only for partial indexes (exactOptionalPropertyTypes)
      if (indexDef.isPartial && index.indpred) {
        return { ...indexDef, predicate: index.indpred };
      }

      return indexDef;
    });
  });
}

// ============================================================================
// Enums
// ============================================================================

/**
 * Build an EnumEntity from a PgType
 */
function buildEnum(pgType: PgType): Effect.Effect<EnumEntity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "type",
    objectName: pgType.typname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const parsed = yield* parseSmartTags(pgType.getDescription(), context);
    const tags = parsed.tags;
    const schemaName = pgType.getNamespace()?.nspname ?? "public";
    const values = pgType.getEnumValues()?.map(v => v.enumlabel) ?? [];

    return {
      kind: "enum" as const,
      name: inflection.enumName(pgType, tags),
      pgName: pgType.typname,
      schemaName,
      pgType,
      values,
      tags,
    };
  });
}

// ============================================================================
// Domains
// ============================================================================

/**
 * Get domain constraints from pg_constraint.
 * Domain constraints have contypid set to the domain's OID.
 */
function getDomainConstraints(
  pgType: PgType,
  introspection: Introspection,
): readonly DomainConstraint[] {
  // Find constraints where contypid matches the domain type's OID
  const domainOid = pgType._id;

  return introspection.constraints
    .filter(c => c.contypid === domainOid && c.contype === "c") // CHECK constraints
    .map(c => {
      const constraint: DomainConstraint = {
        name: c.conname,
      };
      // Add expression only if present (exactOptionalPropertyTypes)
      if (c.consrc) {
        return { ...constraint, expression: c.consrc };
      }
      return constraint;
    });
}

/**
 * Build a DomainEntity from a PgType
 */
function buildDomain(
  pgType: PgType,
  introspection: Introspection,
): Effect.Effect<DomainEntity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "type",
    objectName: pgType.typname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const parsed = yield* parseSmartTags(pgType.getDescription(), context);
    const tags = parsed.tags;
    const schemaName = pgType.getNamespace()?.nspname ?? "public";

    // Get base type info
    const baseTypeOid = pgType.typbasetype;
    const baseType = baseTypeOid ? introspection.getType({ id: String(baseTypeOid) }) : undefined;
    const baseTypeName = baseType?.typname ?? "unknown";

    // Check for NOT NULL constraint (typnotnull)
    const notNull = pgType.typnotnull === true;

    // Get CHECK constraints
    const constraints = getDomainConstraints(pgType, introspection);

    return {
      kind: "domain" as const,
      name: inflection.enumName(pgType, tags), // enumName works for all PgType
      pgName: pgType.typname,
      schemaName,
      pgType,
      baseTypeName,
      baseTypeOid: baseTypeOid ? Number(baseTypeOid) : 0,
      notNull,
      constraints,
      tags,
    };
  });
}

// ============================================================================
// Composites
// ============================================================================

/**
 * Build a Field from a PgAttribute for composite types.
 * Sets sensible defaults for properties that don't apply to composites.
 */
function buildCompositeField(
  attr: PgAttribute,
  tags: SmartTags,
  introspection: Introspection,
): Effect.Effect<Field, never, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const pgType = attr.getType();

    // Array handling
    const isArray = pgType?.typcategory === "A";
    const elementType = isArray ? pgType?.getElemType() : undefined;

    // Resolve domain base type for proper type mapping
    const domainBaseType = resolveDomainBaseType(pgType, introspection);

    const nullable = !(attr.attnotnull ?? false);

    // Composite fields use Field interface with defaults for inapplicable properties
    const field: Field = {
      name: inflection.fieldName(attr, tags),
      columnName: attr.attname,
      pgAttribute: attr,
      nullable,
      optional: false, // Composites don't have optional fields
      hasDefault: false, // Composites don't have defaults
      isGenerated: false,
      isIdentity: false,
      isArray,
      tags,
      extensions: new Map(),
      permissions: { canSelect: true, canInsert: true, canUpdate: true },
    };

    // Build result with optional properties (exactOptionalPropertyTypes)
    let result = field;
    if (elementType?.typname !== undefined) {
      result = { ...result, elementTypeName: elementType.typname };
    }
    if (domainBaseType !== undefined) {
      result = { ...result, domainBaseType };
    }

    return result;
  });
}

/**
 * Build a CompositeEntity from a PgType
 */
function buildComposite(
  pgType: PgType,
  introspection: Introspection,
): Effect.Effect<CompositeEntity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "type",
    objectName: pgType.typname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const parsed = yield* parseSmartTags(pgType.getDescription(), context);
    const tags = parsed.tags;
    const schemaName = pgType.getNamespace()?.nspname ?? "public";

    // Get attributes for the composite type via its associated pg_class
    // Composite types have a pg_class entry with relkind = 'c'
    const pgClass = pgType.getClass();
    const attributes = pgClass?.getAttributes()?.filter(a => a.attnum > 0) ?? [];

    // Parse attribute tags and build fields
    const fields = yield* Effect.forEach(attributes, attr => {
      const attrContext: TagContext = {
        objectType: "column",
        objectName: `${pgType.typname}.${attr.attname}`,
      };
      return parseSmartTags(attr.getDescription(), attrContext).pipe(
        Effect.flatMap(attrParsed => buildCompositeField(attr, attrParsed.tags, introspection)),
      );
    });

    return {
      kind: "composite" as const,
      name: inflection.enumName(pgType, tags), // enumName works for all PgType
      pgName: pgType.typname,
      schemaName,
      pgType,
      fields,
      tags,
    };
  });
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build entity name lookup map (oid -> entity name)
 * This is needed for relation building to know target entity names
 */
function buildEntityNameLookup(
  classes: readonly PgClass[],
): Effect.Effect<ReadonlyMap<string, string>, TagParseError, Inflection> {
  return Effect.gen(function* () {
    const inflection = yield* Inflection;

    return yield* Effect.reduce(classes, new Map<string, string>(), (map, pgClass) => {
      const context: TagContext = {
        objectType: "table",
        objectName: pgClass.relname,
      };

      return parseSmartTags(pgClass.getDescription(), context).pipe(
        Effect.map(parsed => {
          const name = inflection.entityName(pgClass, parsed.tags);
          map.set(pgClass._id, name);
          return map;
        }),
      );
    });
  });
}

/**
 * Filter classes to include (tables and views in specified schemas)
 */
function filterClasses(
  introspection: Introspection,
  schemas: readonly string[],
): readonly PgClass[] {
  const schemaSet = new Set(schemas);

  return introspection.classes.filter(c => {
    const namespace = c.getNamespace()?.nspname;
    if (!namespace || !schemaSet.has(namespace)) return false;

    // Include tables, views, materialized views
    return c.relkind === "r" || c.relkind === "v" || c.relkind === "m";
  });
}

/**
 * Filter enum types in specified schemas
 */
function filterEnums(introspection: Introspection, schemas: readonly string[]): readonly PgType[] {
  const schemaSet = new Set(schemas);

  return introspection.types.filter(t => {
    const namespace = t.getNamespace()?.nspname;
    if (!namespace || !schemaSet.has(namespace)) return false;

    return t.typtype === "e"; // enum type
  });
}

/**
 * Filter domain types in specified schemas
 */
function filterDomains(
  introspection: Introspection,
  schemas: readonly string[],
): readonly PgType[] {
  const schemaSet = new Set(schemas);

  return introspection.types.filter(t => {
    const namespace = t.getNamespace()?.nspname;
    if (!namespace || !schemaSet.has(namespace)) return false;

    return t.typtype === "d"; // domain type
  });
}

/**
 * Filter user-defined composite types in specified schemas.
 * Excludes table/view row types (those have relkind = 'r' or 'v').
 * Only includes composites with relkind = 'c' (standalone composite types).
 */
function filterComposites(
  introspection: Introspection,
  schemas: readonly string[],
): readonly PgType[] {
  const schemaSet = new Set(schemas);

  return introspection.types.filter(t => {
    const namespace = t.getNamespace()?.nspname;
    if (!namespace || !schemaSet.has(namespace)) return false;

    // Composite types have typtype === "c"
    if (t.typtype !== "c") return false;

    // Get the associated class to check its relkind
    // User-defined composites have relkind = 'c'
    // Table row types have relkind = 'r', view row types have relkind = 'v'
    const pgClass = t.getClass();
    return pgClass?.relkind === "c";
  });
}

/**
 * Extract extension info from introspection.
 * Extensions are needed for type mapping (e.g., citext -> string).
 */
function extractExtensions(introspection: Introspection): readonly ExtensionInfo[] {
  return introspection.extensions.map(ext => ({
    name: ext.extname,
    namespaceOid: String(ext.extnamespace ?? ""),
    version: ext.extversion,
  }));
}

/**
 * Get the fully qualified type name from a PgType.
 */
function getTypeName(pgType: PgType | undefined): string {
  return pipe(
    Option.fromNullable(pgType),
    Option.map(t => {
      const ns = t.getNamespace()?.nspname;
      return ns ? `${ns}.${t.typname}` : t.typname;
    }),
    Option.getOrElse(() => "unknown"),
  );
}

/**
 * Filter functions in specified schemas.
 * Only includes functions (prokind = 'f'), not procedures.
 *
 * @param introspection - The introspection result
 * @param schemas - Schemas to include functions from
 * @param options - Optional filter settings
 */
function filterFunctions(
  introspection: Introspection,
  schemas: readonly string[],
  options?: {
    /** Exclude functions that belong to extensions (default: true) */
    excludeExtensions?: boolean;
  },
): readonly { pgProc: PgProc; isFromExtension: boolean }[] {
  const schemaSet = new Set(schemas);
  const excludeExtensions = options?.excludeExtensions ?? true;

  // Build set of extension namespace OIDs (always build this for tracking)
  const extensionNamespaceOids = new Set(
    introspection.extensions.filter(ext => ext.extnamespace).map(ext => ext.extnamespace),
  );

  return introspection.procs
    .map(proc => {
      const namespace = proc.getNamespace();
      if (!namespace) return null;

      const namespaceName = namespace.nspname;
      if (!namespaceName || !schemaSet.has(namespaceName)) return null;

      // Only include functions, not procedures
      if (proc.prokind !== "f") return null;

      // Check if function belongs to an extension
      const isFromExtension = extensionNamespaceOids.has(namespace._id);

      // Exclude extension functions
      if (excludeExtensions && isFromExtension) {
        return null;
      }

      return { pgProc: proc, isFromExtension };
    })
    .filter((item): item is { pgProc: PgProc; isFromExtension: boolean } => item !== null);
}

/**
 * Build a FunctionEntity from a PgProc.
 */
function buildFunction(
  pgProc: PgProc,
  introspection: Introspection,
  role: PgRoles,
  isFromExtension: boolean,
): Effect.Effect<FunctionEntity, TagParseError, Inflection> {
  const context: TagContext = {
    objectType: "type",
    objectName: pgProc.proname,
  };

  return Effect.gen(function* () {
    const inflection = yield* Inflection;
    const parsed = yield* parseSmartTags(pgProc.getDescription(), context);
    const tags = parsed.tags;
    const schemaName = pgProc.getNamespace()?.nspname ?? "public";

    const returnType = pgProc.getReturnType();
    const returnTypeName = returnType ? getTypeName(returnType) : "void";

    const args = pgProc.getArguments().map(
      (arg): FunctionArg => ({
        name: arg.name ?? "",
        typeName: getTypeName(arg.type),
        hasDefault: arg.hasDefault,
      }),
    );

    const volatilityMap: Record<string, Volatility> = {
      i: "immutable",
      s: "stable",
      v: "volatile",
    };

    const perms = entityPermissions(introspection, pgProc, role);
    const canExecute = perms.execute ?? false;

    const volatilityKey = pgProc.provolatile ?? "v";
    const volatility = volatilityMap[volatilityKey] ?? "volatile";

    return {
      kind: "function" as const,
      name: inflection.functionName(pgProc, tags),
      pgName: pgProc.proname,
      schemaName,
      pgProc,
      returnTypeName,
      returnsSet: pgProc.proretset ?? false,
      argCount: pgProc.pronargs ?? 0,
      args,
      volatility,
      isStrict: pgProc.proisstrict ?? false,
      canExecute,
      isFromExtension,
      tags,
    };
  });
}

/**
 * Create the live IR builder implementation
 */
function createIRBuilderImpl(): IRBuilder {
  return {
    build: (introspection, options) =>
      Effect.gen(function* () {
        const classes = filterClasses(introspection, options.schemas);
        const enumTypes = filterEnums(introspection, options.schemas);
        const domainTypes = filterDomains(introspection, options.schemas);
        const compositeTypes = filterComposites(introspection, options.schemas);
        const functionProcs = filterFunctions(introspection, options.schemas, {
          excludeExtensions: options.excludeExtensionFunctions ?? true,
        });

        // Get the role for permission checks
        // If options.role is specified, look it up. Otherwise fall back to current user.
        const fallbackRole: PgRoles = {
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
        };
        const role: PgRoles = options.role
          ? (introspection.roles.find(r => r.rolname === options.role) ?? fallbackRole)
          : (introspection.getCurrentUser() ?? fallbackRole);

        // Build entity name lookup first (needed for relations)
        const entityNameLookup = yield* buildEntityNameLookup(classes);

        // Build table/view entities
        const entities = yield* Effect.forEach(classes, pgClass =>
          buildEntity(pgClass, entityNameLookup, introspection, role),
        );

        // Build enums
        const enums = yield* Effect.forEach(enumTypes, pgType => buildEnum(pgType));

        // Build domains
        const domains = yield* Effect.forEach(domainTypes, pgType =>
          buildDomain(pgType, introspection),
        );

        // Build composites
        const composites = yield* Effect.forEach(compositeTypes, pgType =>
          buildComposite(pgType, introspection),
        );

        // Build functions
        const allFunctions = yield* Effect.forEach(functionProcs, ({ pgProc, isFromExtension }) =>
          buildFunction(pgProc, introspection, role, isFromExtension),
        );

        // Dedupe functions by inflected name, warning about overloads
        const uniqueFunctions = yield* Effect.reduce(
          allFunctions,
          new Map<string, FunctionEntity>(),
          (seen, fn) =>
            pipe(
              Option.fromNullable(seen.get(fn.name)),
              Option.match({
                onNone: () => Effect.succeed(seen.set(fn.name, fn)),
                onSome: existing =>
                  Console.warn(
                    `Skipping overloaded function ${fn.schemaName}.${fn.pgName}(${fn.argCount} args) - ` +
                      `conflicts with ${existing.schemaName}.${existing.pgName}(${existing.argCount} args). ` +
                      `Both resolve to "${fn.name}". Use @name tag to disambiguate.`,
                  ).pipe(Effect.as(seen)),
              }),
            ),
        ).pipe(Effect.map(m => [...m.values()]));

        // Extract extensions for type mapping
        const extensions = extractExtensions(introspection);

        // Assemble IR
        const builder = createIRBuilder(options.schemas);
        const allEntities = [...entities, ...enums, ...domains, ...composites, ...uniqueFunctions];
        Arr.forEach(allEntities, entity => {
          builder.entities.set(entity.name, entity);
        });
        builder.extensions.push(...extensions);

        return freezeIR(builder);
      }),
  };
}

// ============================================================================
// Layers
// ============================================================================

/**
 * Live layer - provides IRBuilder service
 * Note: IRBuilder.build() requires Inflection to be provided at call time
 */
export const IRBuilderLive = Layer.succeed(IRBuilderSvc, createIRBuilderImpl());

/**
 * Factory function for creating IR builder
 * Note: The returned builder's build() method requires Inflection in the Effect context
 */
export function createIRBuilderService(): IRBuilder {
  return createIRBuilderImpl();
}
