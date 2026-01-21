/**
 * Type-building helpers for TypeScript AST nodes
 *
 * Higher-level helpers for building type annotations from IR Fields and
 * PostgreSQL type names. Built on top of the low-level AST builders in
 * lib/conjure.ts.
 */
import recast from "recast";
import type { TSTypeKind } from "ast-types/lib/gen/kinds.js";
import type { Field } from "../ir/semantic-ir.js";

const b = recast.types.builders;

// =============================================================================
// PostgreSQL to TypeScript type mapping
// =============================================================================

const PG_STRING_TYPES = new Set([
  "uuid",
  "text",
  "varchar",
  "char",
  "character",
  "name",
  "bpchar",
  "citext",
]);

const PG_NUMBER_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "integer",
  "smallint",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "float4",
  "float8",
  "double",
]);

const PG_BOOLEAN_TYPES = new Set(["bool", "boolean"]);

const PG_DATE_TYPES = new Set(["timestamp", "timestamptz", "date", "time", "timetz"]);

const PG_JSON_TYPES = new Set(["json", "jsonb"]);

const PG_BINARY_TYPES = new Set(["bytea", "blob"]);

/**
 * Map a PostgreSQL type name to a TypeScript AST type node.
 * @internal
 */
function pgTypeToTsType(pgType: string): TSTypeKind {
  const normalized = pgType.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) return b.tsStringKeyword();
  if (PG_NUMBER_TYPES.has(normalized)) return b.tsNumberKeyword();
  if (PG_BOOLEAN_TYPES.has(normalized)) return b.tsBooleanKeyword();
  if (PG_DATE_TYPES.has(normalized)) return b.tsTypeReference(b.identifier("Date"));
  if (PG_JSON_TYPES.has(normalized)) return b.tsUnknownKeyword();
  if (PG_BINARY_TYPES.has(normalized)) return b.tsTypeReference(b.identifier("Buffer"));

  return b.tsUnknownKeyword();
}

// =============================================================================
// Type builders
// =============================================================================

/** Build a string type */
export function string(): TSTypeKind {
  return b.tsStringKeyword();
}

/** Build a number type */
export function number(): TSTypeKind {
  return b.tsNumberKeyword();
}

/** Build a boolean type */
export function boolean(): TSTypeKind {
  return b.tsBooleanKeyword();
}

/** Build a null type */
function nullType(): TSTypeKind {
  return b.tsNullKeyword();
}
export { nullType as null };

/** Build an undefined type */
function undefinedType(): TSTypeKind {
  return b.tsUndefinedKeyword();
}
export { undefinedType as undefined };

/** Build an unknown type */
export function unknown(): TSTypeKind {
  return b.tsUnknownKeyword();
}

/** Build a void type */
function voidType(): TSTypeKind {
  return b.tsVoidKeyword();
}
export { voidType as void };

/**
 * Build a type reference by name
 * @example
 * types.ref("User")  // -> TSTypeReference for "User"
 */
export function ref(name: string): TSTypeKind {
  return b.tsTypeReference(b.identifier(name));
}

/**
 * Build a union type
 * @example
 * types.union(types.string(), types.null())  // -> string | null
 */
export function union(...members: TSTypeKind[]): TSTypeKind {
  return b.tsUnionType(members);
}

/**
 * Build an array type
 * @example
 * types.array(types.string())  // -> string[]
 */
export function array(elementType: TSTypeKind): TSTypeKind {
  return b.tsArrayType(elementType);
}

/**
 * Make a type nullable (union with null)
 * @example
 * types.nullable(types.string())  // -> string | null
 */
export function nullable(type: TSTypeKind): TSTypeKind {
  return b.tsUnionType([type, b.tsNullKeyword()]);
}

/**
 * Build a generic type with type parameters
 * @example
 * types.generic("Promise", types.string())  // -> Promise<string>
 * types.generic("Map", types.string(), types.number())  // -> Map<string, number>
 */
export function generic(name: string, ...typeArgs: TSTypeKind[]): TSTypeKind {
  if (typeArgs.length === 0) {
    return b.tsTypeReference(b.identifier(name));
  }
  return b.tsTypeReference(b.identifier(name), b.tsTypeParameterInstantiation(typeArgs));
}

/**
 * Build a type from a PostgreSQL type name
 * @example
 * types.fromPg("uuid")        // -> string
 * types.fromPg("int4")        // -> number
 * types.fromPg("jsonb", true) // -> unknown | null
 */
export function fromPg(pgType: string, isNullable = false): TSTypeKind {
  const baseType = pgTypeToTsType(pgType);
  return isNullable ? nullable(baseType) : baseType;
}

/**
 * Build a type from an IR Field
 *
 * Uses the field's type information, handling nullability and arrays.
 * @example
 * types.fromField(idField)    // -> string (for uuid NOT NULL)
 * types.fromField(tagsField)  // -> string[] | null (for text[] NULL)
 */
export function fromField(field: Field): TSTypeKind {
  const pgType = field.pgAttribute.getType();

  if (!pgType) {
    return b.tsUnknownKeyword();
  }

  // For array types, use the element type name
  const typeName =
    pgType.typcategory === "A" ? (field.elementTypeName ?? "unknown") : pgType.typname;

  let resultType = pgTypeToTsType(typeName);

  if (field.isArray) {
    resultType = array(resultType);
  }

  if (field.nullable) {
    resultType = nullable(resultType);
  }

  return resultType;
}

// =============================================================================
// Namespace export for convenient grouped usage
// =============================================================================

/**
 * Type-building helpers for constructing TypeScript type annotations.
 *
 * Can be used as namespace or individual imports:
 * @example
 * import { types } from "./conjure/types.js"
 * types.string()
 * types.nullable(types.ref("User"))
 *
 * @example
 * import { string, nullable, ref } from "./conjure/types.js"
 * nullable(ref("User"))
 */
export const types = {
  string,
  number,
  boolean,
  null: nullType,
  undefined: undefinedType,
  unknown,
  void: voidType,
  ref,
  union,
  array,
  nullable,
  generic,
  fromPg,
  fromField,
};
