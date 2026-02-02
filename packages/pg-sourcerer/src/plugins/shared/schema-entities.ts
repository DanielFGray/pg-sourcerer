/**
 * Shared helpers for schema plugins (zod, arktype, valibot)
 *
 * Provides common entity classification, field modifier handling,
 * type mapping, and validation application patterns.
 */
import { pipe } from "effect";
import type {
  Entity,
  TableEntity,
  EnumEntity,
  DomainEntity,
  Field,
  DomainValidation,
} from "../../ir/semantic-ir.js";
import { isTableEntity, isEnumEntity, isDomainEntity } from "../../ir/semantic-ir.js";
import {
  pgStringTypes,
  pgNumberTypes,
  pgBooleanTypes,
  pgDateTypes,
  pgJsonTypes,
} from "./pg-types.js";

// =============================================================================
// Entity Classification
// =============================================================================

/**
 * Classified entities by kind for easy iteration in plugins.
 */
export interface ClassifiedEntities {
  readonly all: readonly Entity[];
  readonly enums: readonly EnumEntity[];
  readonly domains: readonly DomainEntity[];
  readonly tables: readonly TableEntity[];
}

/**
 * Classify entities from the IR into enums, domains, and tables.
 *
 * @example
 * ```typescript
 * const { enums, domains, tables } = classifyEntities(ir.entities.values());
 * ```
 */
export function classifyEntities(entities: Iterable<Entity>): ClassifiedEntities {
  const all = [...entities];
  return {
    all,
    enums: all.filter(isEnumEntity),
    domains: all.filter(isDomainEntity),
    tables: all.filter(isTableEntity),
  };
}

// =============================================================================
// Shape Iteration
// =============================================================================

/**
 * Get all defined shapes from a table entity.
 * Returns row, insert, and update shapes (if defined).
 *
 * @example
 * ```typescript
 * const shapes = getEntityShapes(entity);
 * shapes.forEach(shape => renderShape(shape));
 * ```
 */
export function getEntityShapes(
  entity: TableEntity,
): readonly NonNullable<TableEntity["shapes"]["row"]>[] {
  return [entity.shapes.row, entity.shapes.insert, entity.shapes.update].filter(
    Boolean,
  ) as NonNullable<TableEntity["shapes"]["row"]>[];
}

// =============================================================================
// Type Categorization
// =============================================================================

/**
 * High-level PostgreSQL type categories for schema mapping.
 */
export type PgTypeCategory =
  | "string"
  | "uuid"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "enum"
  | "domain"
  | "unknown";

/**
 * Categorize a PostgreSQL type into a high-level category.
 *
 * @example
 * ```typescript
 * const category = categorizePgType("varchar", { typcategory: "S" });
 * // Returns "string"
 * ```
 */
export function categorizePgType(
  typeName: string,
  typeInfo: { typcategory?: string | null; typtype?: string | null },
): PgTypeCategory {
  const normalized = typeName.toLowerCase();

  // Domain types
  if (typeInfo.typtype === "d") {
    return "domain";
  }

  // Enum types
  if (typeInfo.typtype === "e" || typeInfo.typcategory === "E") {
    return "enum";
  }

  // UUID is a special case of string
  if (normalized === "uuid") {
    return "uuid";
  }

  if (pgStringTypes.has(normalized)) {
    return "string";
  }

  if (pgNumberTypes.has(normalized)) {
    return "number";
  }

  if (pgBooleanTypes.has(normalized)) {
    return "boolean";
  }

  if (pgDateTypes.has(normalized)) {
    return "date";
  }

  if (pgJsonTypes.has(normalized)) {
    return "json";
  }

  return "unknown";
}

// =============================================================================
// Field Modifiers
// =============================================================================

/**
 * Field modifiers that affect schema wrapping.
 */
export interface FieldModifiers {
  readonly isArray: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;
}

/**
 * Adapter interface for applying modifiers to a schema.
 * Each schema library implements this differently.
 */
export interface ModifierAdapter<TSchema> {
  /** Wrap the schema as an array type */
  array(schema: TSchema): TSchema;
  /** Make the schema nullable */
  nullable(schema: TSchema): TSchema;
  /** Make the schema optional */
  optional(schema: TSchema): TSchema;
}

/**
 * Extract field modifiers from a Field.
 *
 * @example
 * ```typescript
 * const modifiers = getFieldModifiers(field);
 * // { isArray: false, nullable: true, optional: false }
 * ```
 */
export function getFieldModifiers(field: Field): FieldModifiers {
  return {
    isArray: field.isArray,
    nullable: field.nullable,
    optional: field.optional,
  };
}

/**
 * Apply modifiers to a base schema using the provided adapter.
 * Order: array → nullable → optional
 *
 * @example
 * ```typescript
 * const zodAdapter: ModifierAdapter<n.Expression> = {
 *   array: s => conjure.chain(s).method("array").build(),
 *   nullable: s => conjure.chain(s).method("nullable").build(),
 *   optional: s => conjure.chain(s).method("optional").build(),
 * };
 * const schema = applyModifiers(baseSchema, getFieldModifiers(field), zodAdapter);
 * ```
 */
export function applyModifiers<T>(
  schema: T,
  modifiers: FieldModifiers,
  adapter: ModifierAdapter<T>,
): T {
  return pipe(
    schema,
    s => (modifiers.isArray ? adapter.array(s) : s),
    s => (modifiers.nullable ? adapter.nullable(s) : s),
    s => (modifiers.optional ? adapter.optional(s) : s),
  );
}

// =============================================================================
// Type Mapping Discriminated Union
// =============================================================================

/**
 * Result of mapping a field type to a schema.
 * - `schema`: Direct schema expression
 * - `enumRef`: Reference to a separately defined enum schema
 * - `domainRef`: Reference to a separately defined domain schema
 */
export type TypeMapping<TSchema> =
  | { readonly kind: "schema"; readonly schema: TSchema }
  | { readonly kind: "enumRef"; readonly enumRef: string }
  | { readonly kind: "domainRef"; readonly domainRef: string };

/**
 * Create a direct schema mapping.
 */
export function schemaMapping<T>(schema: T): TypeMapping<T> {
  return { kind: "schema", schema };
}

/**
 * Create an enum reference mapping.
 */
export function enumRefMapping<T>(enumRef: string): TypeMapping<T> {
  return { kind: "enumRef", enumRef };
}

/**
 * Create a domain reference mapping.
 */
export function domainRefMapping<T>(domainRef: string): TypeMapping<T> {
  return { kind: "domainRef", domainRef };
}

// =============================================================================
// Domain Validation Application
// =============================================================================

/**
 * Adapter interface for applying domain validations to a schema.
 * Each schema library implements these constraint methods differently.
 */
export interface ValidationAdapter<TSchema> {
  /** Apply minimum length constraint (for strings) */
  minLength(schema: TSchema, value: number): TSchema;
  /** Apply maximum length constraint (for strings) */
  maxLength(schema: TSchema, value: number): TSchema;
  /** Apply minimum value constraint (for numbers) */
  min(schema: TSchema, value: number): TSchema;
  /** Apply maximum value constraint (for numbers) */
  max(schema: TSchema, value: number): TSchema;
  /** Apply regex pattern constraint */
  regex(schema: TSchema, pattern: string, flags?: string): TSchema;
}

/**
 * Apply a single validation to a schema.
 *
 * @returns The schema with the validation applied, or unchanged for unknown validations
 */
export function applyValidation<T>(
  schema: T,
  validation: DomainValidation,
  adapter: ValidationAdapter<T>,
): T {
  switch (validation.kind) {
    case "minLength":
      return adapter.minLength(schema, validation.value);
    case "maxLength":
      return adapter.maxLength(schema, validation.value);
    case "min":
      return adapter.min(schema, validation.value);
    case "max":
      return adapter.max(schema, validation.value);
    case "regex":
      return adapter.regex(schema, validation.pattern, validation.caseInsensitive ? "i" : "");
    case "unknown":
      // Can't apply unknown validations
      return schema;
  }
}

/**
 * Apply all validations from a domain's constraints to a schema.
 *
 * @example
 * ```typescript
 * const zodValidationAdapter: ValidationAdapter<n.Expression> = {
 *   minLength: (s, v) => conjure.chain(s).method("min", [conjure.num(v)]).build(),
 *   maxLength: (s, v) => conjure.chain(s).method("max", [conjure.num(v)]).build(),
 *   min: (s, v) => conjure.chain(s).method("min", [conjure.num(v)]).build(),
 *   max: (s, v) => conjure.chain(s).method("max", [conjure.num(v)]).build(),
 *   regex: (s, p, f) => conjure.chain(s).method("regex", [conjure.regex(p, f ?? "")]).build(),
 * };
 * const validatedSchema = applyDomainValidations(baseSchema, domain, zodValidationAdapter);
 * ```
 */
export function applyDomainValidations<T>(
  schema: T,
  domain: DomainEntity,
  adapter: ValidationAdapter<T>,
): T {
  return domain.constraints
    .flatMap(c => c.validations)
    .reduce((s, validation) => applyValidation(s, validation, adapter), schema);
}

// =============================================================================
// Base Type Schema Generation
// =============================================================================

/**
 * Adapter for generating base type schemas.
 * Each schema library provides its own primitives.
 */
export interface BaseTypeAdapter<TSchema> {
  string(): TSchema;
  uuid(): TSchema;
  number(): TSchema;
  boolean(): TSchema;
  date(): TSchema;
  json(): TSchema;
  unknown(): TSchema;
}

/**
 * Generate a base schema from a PostgreSQL type category.
 */
export function baseSchemaFromCategory<T>(
  category: PgTypeCategory,
  adapter: BaseTypeAdapter<T>,
): T {
  switch (category) {
    case "string":
      return adapter.string();
    case "uuid":
      return adapter.uuid();
    case "number":
      return adapter.number();
    case "boolean":
      return adapter.boolean();
    case "date":
      return adapter.date();
    case "json":
      return adapter.json();
    default:
      return adapter.unknown();
  }
}

/**
 * Get a base schema for a domain's underlying type.
 */
export function domainBaseSchema<T>(domain: DomainEntity, adapter: BaseTypeAdapter<T>): T {
  const baseType = domain.baseTypeName.toLowerCase();

  if (pgStringTypes.has(baseType)) {
    return adapter.string();
  }
  if (pgNumberTypes.has(baseType)) {
    return adapter.number();
  }
  if (pgBooleanTypes.has(baseType)) {
    return adapter.boolean();
  }
  if (pgDateTypes.has(baseType)) {
    return adapter.date();
  }
  if (pgJsonTypes.has(baseType)) {
    return adapter.json();
  }
  return adapter.unknown();
}
