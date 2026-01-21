/**
 * Pure functions that convert QueryDescriptor to other representations
 *
 * These converters transform query metadata into AST representations for code generation.
 * They are pure functions with no side effects, making them easy to test and compose.
 */

import recast from "recast";
import type { TSTypeKind, IdentifierKind } from "ast-types/lib/gen/kinds.js";
import type { QueryDescriptor, ParamDescriptor, ReturnDescriptor } from "./query-types.js";

const b = recast.types.builders;

// =============================================================================
// Type string parser
// =============================================================================

/**
 * Parse a TypeScript type string into an AST type node.
 * Handles simple types and common patterns.
 */
function parseTsTypeString(tsType: string): TSTypeKind {
  const trimmed = tsType.trim();

  switch (trimmed) {
    case "string":
      return b.tsStringKeyword();
    case "number":
      return b.tsNumberKeyword();
    case "boolean":
      return b.tsBooleanKeyword();
    case "void":
      return b.tsVoidKeyword();
    case "null":
      return b.tsNullKeyword();
    case "undefined":
      return b.tsUndefinedKeyword();
    case "unknown":
      return b.tsUnknownKeyword();
    case "any":
      return b.tsAnyKeyword();
    case "Date":
      return b.tsTypeReference(b.identifier("Date"));
    case "Array":
    case "object":
      return b.tsTypeReference(b.identifier(trimmed));
    default:
      if (trimmed.endsWith("[]")) {
        const elementType = parseTsTypeString(trimmed.slice(0, -2));
        return b.tsArrayType(elementType);
      }
      if (trimmed.includes("|")) {
        const members = trimmed.split("|").map(s => parseTsTypeString(s.trim()));
        return b.tsUnionType(members);
      }
      if (trimmed.includes("&")) {
        const members = trimmed.split("&").map(s => parseTsTypeString(s.trim()));
        return b.tsIntersectionType(members);
      }
      return b.tsTypeReference(b.identifier(trimmed));
  }
}

// =============================================================================
// Parameter conversion
// =============================================================================

/**
 * Convert a QueryDescriptor's params to a TypeScript function parameter list.
 * Returns AST nodes for function parameters.
 *
 * @example
 * // Query with params: [{ name: "id", tsType: "string" }, { name: "limit", tsType: "number", hasDefault: true }]
 * paramsToAst(query.params)
 * // -> AST for: (id: string, limit?: number)
 */
export function paramsToAst(params: readonly ParamDescriptor[]): IdentifierKind[] {
  return params.map(param => {
    const typeAnnotation = b.tsTypeAnnotation(parseTsTypeString(param.tsType));
    return b.identifier.from({
      name: param.name,
      typeAnnotation,
      optional: param.hasDefault ?? false,
    });
  });
}

// =============================================================================
// Object type building
// =============================================================================

/**
 * Build an inline object type from fields.
 *
 * @example
 * fieldsToObjectType([{ name: "id", tsType: "string", nullable: false }, { name: "count", tsType: "number", nullable: true }])
 * // -> AST for: { id: string; count: number | null }
 */
export function fieldsToObjectType(
  fields: readonly { name: string; tsType: string; nullable: boolean }[],
): TSTypeKind {
  const properties = fields.map(field => {
    let fieldType = parseTsTypeString(field.tsType);

    // Nullable means the value can be null, not that the property is optional
    if (field.nullable) {
      fieldType = b.tsUnionType([fieldType, b.tsNullKeyword()]);
    }

    return b.tsPropertySignature.from({
      key: b.identifier(field.name),
      typeAnnotation: b.tsTypeAnnotation(fieldType),
    });
  });

  return b.tsTypeLiteral(properties);
}

// =============================================================================
// Return type conversion
// =============================================================================

/**
 * Convert a ReturnDescriptor to a TypeScript type.
 *
 * @example
 * // mode: 'one', fields: [{ name: "id", tsType: "string" }, { name: "name", tsType: "string" }]
 * returnToType(returns)
 * // -> AST for: { id: string; name: string }
 *
 * // mode: 'oneOrNone'
 * // -> AST for: { id: string; name: string } | null
 *
 * // mode: 'many'
 * // -> AST for: { id: string; name: string }[]
 *
 * // mode: 'affected'
 * // -> AST for: number
 *
 * // mode: 'void'
 * // -> AST for: void
 */
export function returnToType(returns: ReturnDescriptor): TSTypeKind {
  switch (returns.mode) {
    case "void":
      return b.tsVoidKeyword();

    case "affected":
      return b.tsNumberKeyword();

    case "one":
      if (returns.fields.length === 0) {
        return b.tsNeverKeyword();
      }
      return fieldsToObjectType(returns.fields);

    case "oneOrNone":
      if (returns.fields.length === 0) {
        return b.tsNullKeyword();
      }
      const rowTypeOneOrNone = fieldsToObjectType(returns.fields);
      return b.tsUnionType([rowTypeOneOrNone, b.tsNullKeyword()]);

    case "many":
      if (returns.fields.length === 0) {
        return b.tsArrayType(b.tsNeverKeyword());
      }
      const rowTypeMany = fieldsToObjectType(returns.fields);
      return b.tsArrayType(rowTypeMany);
  }
}

// =============================================================================
// Query signature conversion
// =============================================================================

/**
 * Convert a QueryDescriptor to a complete function signature type.
 *
 * @example
 * queryToSignature(findUserByIdQuery)
 * // -> AST for: (id: string) => Promise<{ id: string; name: string } | null>
 */
export function queryToSignature(query: QueryDescriptor): TSTypeKind {
  const returnType = returnToType(query.returns);
  const promisedReturn = b.tsTypeReference(
    b.identifier("Promise"),
    b.tsTypeParameterInstantiation([returnType]),
  );

  return b.tsFunctionType.from({
    parameters: paramsToAst(query.params),
    typeAnnotation: b.tsTypeAnnotation(promisedReturn),
  });
}
