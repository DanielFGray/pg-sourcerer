/**
 * Function signature building helpers
 *
 * Higher-level helpers for building function parameters and return types.
 * Works with TypeScript AST nodes from recast.
 */
import recast from "recast";
import type {
  TSTypeKind,
  IdentifierKind,
  RestElementKind,
  ObjectPatternKind,
} from "ast-types/lib/gen/kinds.js";
import * as types from "./types.js";

const b = recast.types.builders;

/**
 * Function parameter types accepted by tsFunctionType
 */
type FnParam = IdentifierKind | RestElementKind | ObjectPatternKind;

// =============================================================================
// Parameter building helpers
// =============================================================================

/**
 * Parameter building helpers.
 */
export const param = {
  /**
   * Create a simple parameter: `name: type`
   * @example
   * param.simple("id", types.string())  // -> id: string
   */
  simple(name: string, type: TSTypeKind): FnParam {
    const id = b.identifier(name);
    id.typeAnnotation = b.tsTypeAnnotation(type);
    return id;
  },

  /**
   * Create an optional parameter: `name?: type`
   * @example
   * param.optional("limit", types.number())  // -> limit?: number
   */
  optional(name: string, type: TSTypeKind): FnParam {
    const id = b.identifier(name);
    id.typeAnnotation = b.tsTypeAnnotation(type);
    id.optional = true;
    return id;
  },

  /**
   * Create a rest parameter: `...name: type[]`
   * @example
   * param.rest("args", types.string())  // -> ...args: string[]
   */
  rest(name: string, elementType: TSTypeKind): FnParam {
    const id = b.identifier(name);
    id.typeAnnotation = b.tsTypeAnnotation(types.array(elementType));
    return b.restElement(id);
  },

  /**
   * Create a destructured object parameter: `{ a, b }: Type`
   * @example
   * param.destructured(["id", "name"], types.ref("UserRow"))
   * // -> { id, name }: UserRow
   */
  destructured(props: string[], type: TSTypeKind): FnParam {
    const pattern = b.objectPattern(
      props.map(prop => {
        const objProp = b.objectProperty(b.identifier(prop), b.identifier(prop));
        objProp.shorthand = true;
        return objProp;
      }),
    );
    pattern.typeAnnotation = b.tsTypeAnnotation(type);
    return pattern;
  },
};

// =============================================================================
// Return type building helpers
// =============================================================================

/**
 * Return type building helpers.
 */
export const returns = {
  /**
   * Wrap type in Promise: `Promise<T>`
   * @example
   * returns.promise(types.string())  // -> Promise<string>
   */
  promise(type: TSTypeKind): TSTypeKind {
    return types.generic("Promise", type);
  },

  /**
   * Wrap type in array: `T[]`
   * @example
   * returns.array(types.string())  // -> string[]
   */
  array(type: TSTypeKind): TSTypeKind {
    return types.array(type);
  },

  /**
   * Make nullable: `T | null`
   * @example
   * returns.nullable(types.string())  // -> string | null
   */
  nullable(type: TSTypeKind): TSTypeKind {
    return types.nullable(type);
  },

  /**
   * Async function returning T: `Promise<T>`
   * Alias for promise() for clarity
   * @example
   * returns.async(types.string())  // -> Promise<string>
   */
  async(type: TSTypeKind): TSTypeKind {
    return types.generic("Promise", type);
  },
};

// =============================================================================
// Function signature builder
// =============================================================================

/**
 * Build a complete function type signature.
 *
 * @example
 * sig(
 *   [param.simple("id", types.string())],
 *   returns.promise(types.nullable(types.ref("User")))
 * )
 * // -> (id: string) => Promise<User | null>
 *
 * @example
 * sig(
 *   [param.simple("email", types.string()), param.optional("limit", types.number())],
 *   returns.array(types.ref("User"))
 * )
 * // -> (email: string, limit?: number) => User[]
 */
export function sig(params: FnParam[], returnType: TSTypeKind): TSTypeKind {
  const fnType = b.tsFunctionType(params);
  fnType.typeAnnotation = b.tsTypeAnnotation(returnType);
  return fnType;
}
