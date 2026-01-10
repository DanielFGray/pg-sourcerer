/**
 * Conjure - AST Builder DSL for recast
 *
 * A fluent, immutable API for constructing JavaScript/TypeScript AST nodes.
 * Wraps recast builders with ergonomic patterns for common code generation tasks.
 *
 * @example
 * ```typescript
 * import { conjure, cast } from "../lib/conjure.js"
 *
 * // Method chains
 * const schema = conjure.id("z")
 *   .method("string")
 *   .method("uuid")
 *   .method("nullable")
 *   .build()
 *
 * // Object literals
 * const config = conjure.obj()
 *   .prop("path", conjure.str("/users"))
 *   .prop("method", conjure.str("GET"))
 *   .build()
 *
 * // Functions
 * const handler = conjure.fn()
 *   .async()
 *   .arrow()
 *   .param("req", conjure.ts.ref("Request"))
 *   .param("res", conjure.ts.ref("Response"))
 *   .body(
 *     conjure.stmt.return(conjure.id("res").method("json", [data]).build())
 *   )
 *   .build()
 * ```
 */
import recast from "recast"
import type { namedTypes as n } from "ast-types"
import type {
  ExpressionKind,
  StatementKind,
  PatternKind,
  TSTypeKind,
  PropertyKind,
  ObjectMethodKind,
  ObjectPropertyKind,
  SpreadPropertyKind,
  SpreadElementKind,
  RestElementKind,
  IdentifierKind,
  ArrayPatternKind,
  ObjectPatternKind,
  TSCallSignatureDeclarationKind,
  TSConstructSignatureDeclarationKind,
  TSIndexSignatureKind,
  TSMethodSignatureKind,
  TSPropertySignatureKind,
} from "ast-types/lib/gen/kinds.js"

const b = recast.types.builders

// =============================================================================
// Recast Interop Types
// =============================================================================

/**
 * The ast-types library uses "Kind" union types that are incompatible with
 * exactOptionalPropertyTypes. We define explicit cast functions that convert
 * from the namedTypes interfaces (n.Expression, n.Statement, etc.) to the
 * Kind types that recast builders expect.
 *
 * This is safe because every member of n.Expression is a member of ExpressionKind.
 */

/** Cast n.Expression to ExpressionKind for recast builder compatibility */
function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind
}

/** Cast n.Statement to StatementKind for recast builder compatibility */
function toStmt(node: n.Statement): StatementKind {
  return node as StatementKind
}

/** Cast n.TSType to TSTypeKind for recast builder compatibility */
function toTSType(node: n.TSType): TSTypeKind {
  return node as TSTypeKind
}

/**
 * Array element types that recast accepts
 */
type ArrayElementLike = ExpressionKind | SpreadElementKind | RestElementKind | null

/**
 * Object property types that recast accepts for objectExpression
 */
type ObjectPropertyLike =
  | PropertyKind
  | ObjectMethodKind
  | ObjectPropertyKind
  | SpreadPropertyKind
  | SpreadElementKind

/**
 * Function parameter types that recast accepts
 */
type FnParamKind = IdentifierKind | RestElementKind | ArrayPatternKind | ObjectPatternKind

/**
 * Interface body member types that recast accepts
 */
type InterfaceBodyMember =
  | TSCallSignatureDeclarationKind
  | TSConstructSignatureDeclarationKind
  | TSIndexSignatureKind
  | TSMethodSignatureKind
  | TSPropertySignatureKind

// =============================================================================
// Type Casts (Public API)
// =============================================================================

/**
 * Type cast helpers for raw recast interop.
 *
 * Use these when mixing conjure with direct recast builder calls.
 * These provide the same functionality as the internal cast functions
 * but are exported for external use.
 */
export const cast = {
  /** Cast n.Expression to ExpressionKind */
  toExpr,
  /** Cast array element (expression or spread) */
  asArrayElem: (node: n.Expression | n.SpreadElement): ArrayElementLike =>
    node as ArrayElementLike,
  /** Cast n.Statement to StatementKind */
  toStmt,
  /** Cast n.TSType to TSTypeKind */
  toTSType,
} as const

// =============================================================================
// Symbol Metadata Types
// =============================================================================

/**
 * Context for symbol registration - identifies what entity/shape this symbol represents.
 */
export interface SymbolContext {
  readonly capability: string
  readonly entity: string
  readonly shape?: string
}

/**
 * Metadata attached to an exported symbol.
 */
export interface SymbolMeta {
  readonly name: string
  readonly capability: string
  readonly entity: string
  readonly shape?: string
  readonly isType: boolean
  readonly isDefault?: boolean
}

/**
 * A statement with attached symbol metadata.
 * Used by exp.* helpers to track exports.
 */
export interface SymbolStatement {
  readonly _tag: "SymbolStatement"
  readonly node: n.Statement
  readonly symbol: SymbolMeta
}

/**
 * A program with extracted symbol metadata.
 * Returned by program() when SymbolStatements are included.
 */
export interface SymbolProgram {
  readonly _tag: "SymbolProgram"
  readonly node: n.Program
  readonly symbols: readonly SymbolMeta[]
}

// =============================================================================
// Chain Builder
// =============================================================================

/**
 * Fluent builder for method chains and property access.
 */
export interface ChainBuilder {
  /** The underlying AST node */
  readonly node: n.Expression

  /** Property access: `.name` */
  prop(name: string): ChainBuilder

  /** Method call: `.name(args)` */
  method(name: string, args?: n.Expression[]): ChainBuilder

  /** Direct call: `(args)` */
  call(args?: n.Expression[]): ChainBuilder

  /** Computed property access: `[expr]` */
  index(expr: n.Expression): ChainBuilder

  /** Finalize and return the expression */
  build(): n.Expression
}

function createChain(start: n.Expression): ChainBuilder {
  return {
    node: start,

    prop(name) {
      return createChain(
        b.memberExpression(toExpr(this.node), b.identifier(name))
      )
    },

    method(name, args = []) {
      return createChain(
        b.callExpression(
          b.memberExpression(toExpr(this.node), b.identifier(name)),
          args.map(toExpr)
        )
      )
    },

    call(args = []) {
      return createChain(
        b.callExpression(toExpr(this.node), args.map(toExpr))
      )
    },

    index(expr) {
      return createChain(
        b.memberExpression(toExpr(this.node), toExpr(expr), true)
      )
    },

    build() {
      return this.node
    },
  }
}

// =============================================================================
// Object Builder
// =============================================================================

/**
 * Fluent builder for object literals.
 */
export interface ObjBuilder {
  /** Add a property: `key: value` */
  prop(key: string, value: n.Expression): ObjBuilder

  /** Add a property with string literal key: `"key": value` (for keys with special chars) */
  stringProp(key: string, value: n.Expression): ObjBuilder

  /** Add a computed property: `[key]: value` */
  computed(key: n.Expression, value: n.Expression): ObjBuilder

  /** Add a spread: `...expr` */
  spread(expr: n.Expression): ObjBuilder

  /** Add a shorthand property: `key` (where key is also the value identifier) */
  shorthand(key: string): ObjBuilder

  /** Finalize and return the object expression */
  build(): n.ObjectExpression
}

// Internal: properly typed for recast builder compatibility
function createObj(props: ObjectPropertyLike[] = []): ObjBuilder {
  return {
    prop(key, value) {
      const newProp = b.objectProperty(
        b.identifier(key),
        toExpr(value)
      )
      return createObj([...props, newProp])
    },

    stringProp(key, value) {
      const newProp = b.objectProperty(
        b.stringLiteral(key),
        toExpr(value)
      )
      return createObj([...props, newProp])
    },

    computed(key, value) {
      const prop = b.objectProperty(toExpr(key), toExpr(value))
      prop.computed = true
      return createObj([...props, prop])
    },

    spread(expr) {
      const spreadElem = b.spreadElement(toExpr(expr))
      return createObj([...props, spreadElem])
    },

    shorthand(key) {
      const prop = b.objectProperty(b.identifier(key), b.identifier(key))
      prop.shorthand = true
      return createObj([...props, prop])
    },

    build() {
      return b.objectExpression(props)
    },
  }
}

// =============================================================================
// Array Builder
// =============================================================================

/**
 * Fluent builder for array literals.
 */
export interface ArrBuilder {
  /** Add one or more elements */
  add(...exprs: n.Expression[]): ArrBuilder

  /** Add a spread element: `...expr` */
  spread(expr: n.Expression): ArrBuilder

  /** Finalize and return the array expression */
  build(): n.ArrayExpression
}

// Internal: properly typed for recast builder compatibility
function createArr(elems: ArrayElementLike[] = []): ArrBuilder {
  return {
    add(...exprs) {
      const newElems = exprs.map((e) => toExpr(e) as ArrayElementLike)
      return createArr([...elems, ...newElems])
    },

    spread(expr) {
      const spreadElem = b.spreadElement(toExpr(expr))
      return createArr([...elems, spreadElem])
    },

    build() {
      return b.arrayExpression(elems)
    },
  }
}

// =============================================================================
// Function Builder
// =============================================================================

interface FnParam {
  name: string
  type: n.TSType | undefined
  optional: boolean
  rest: boolean
  defaultValue: n.Expression | undefined
}

interface FnConfig {
  params: FnParam[]
  body: n.Statement[]
  returnType: n.TSType | null
  isAsync: boolean
  isArrow: boolean
  isGenerator: boolean
}

const defaultParam = (name: string, type?: n.TSType): FnParam => ({
  name,
  type,
  optional: false,
  rest: false,
  defaultValue: undefined,
})

/**
 * Fluent builder for function expressions and declarations.
 */
export interface FnBuilder {
  /** Add a required parameter */
  param(name: string, type?: n.TSType): FnBuilder

  /** Add an optional parameter */
  optionalParam(name: string, type?: n.TSType): FnBuilder

  /** Add a rest parameter: `...name` */
  restParam(name: string, type?: n.TSType): FnBuilder

  /** Add a parameter with a default value */
  defaultParam(name: string, defaultValue: n.Expression, type?: n.TSType): FnBuilder

  /** Set the return type annotation */
  returns(type: n.TSType): FnBuilder

  /** Set the function body */
  body(...statements: n.Statement[]): FnBuilder

  /** Mark as async */
  async(): FnBuilder

  /** Make it an arrow function */
  arrow(): FnBuilder

  /** Make it a generator function */
  generator(): FnBuilder

  /** Build as a function expression */
  build(): n.Expression

  /** Build as a named function declaration */
  toDeclaration(name: string): n.FunctionDeclaration
}

function createFn(config: FnConfig): FnBuilder {
  const buildParams = (): PatternKind[] =>
    config.params.map((p): PatternKind => {
      if (p.rest) {
        const restId = b.identifier(p.name)
        if (p.type) {
          restId.typeAnnotation = b.tsTypeAnnotation(toTSType(p.type))
        }
        return b.restElement(restId) as PatternKind
      } else if (p.defaultValue) {
        // For default params, type annotation goes on the identifier
        const id = b.identifier(p.name)
        if (p.type) {
          id.typeAnnotation = b.tsTypeAnnotation(toTSType(p.type))
        }
        return b.assignmentPattern(id, toExpr(p.defaultValue)) as PatternKind
      } else {
        const param = b.identifier(p.name)
        if (p.type) {
          param.typeAnnotation = b.tsTypeAnnotation(toTSType(p.type))
        }
        if (p.optional) {
          param.optional = true
        }
        return param as PatternKind
      }
    })

  return {
    param(name, type) {
      return createFn({
        ...config,
        params: [...config.params, defaultParam(name, type)],
      })
    },

    optionalParam(name, type) {
      return createFn({
        ...config,
        params: [...config.params, { ...defaultParam(name, type), optional: true }],
      })
    },

    restParam(name, type) {
      return createFn({
        ...config,
        params: [...config.params, { ...defaultParam(name, type), rest: true }],
      })
    },

    defaultParam(name, defaultValue, type) {
      return createFn({
        ...config,
        params: [...config.params, { ...defaultParam(name, type), defaultValue }],
      })
    },

    returns(type) {
      return createFn({ ...config, returnType: type })
    },

    body(...statements) {
      return createFn({ ...config, body: statements })
    },

    async() {
      return createFn({ ...config, isAsync: true })
    },

    arrow() {
      return createFn({ ...config, isArrow: true })
    },

    generator() {
      return createFn({ ...config, isGenerator: true })
    },

    build() {
      const params = buildParams()
      const block = b.blockStatement(config.body.map(toStmt))

      if (config.isArrow) {
        const fn = b.arrowFunctionExpression(params, block, false)
        fn.async = config.isAsync
        if (config.returnType) {
          fn.returnType = b.tsTypeAnnotation(toTSType(config.returnType))
        }
        return fn
      } else {
        const fn = b.functionExpression(null, params, block, config.isGenerator)
        fn.async = config.isAsync
        if (config.returnType) {
          fn.returnType = b.tsTypeAnnotation(toTSType(config.returnType))
        }
        return fn
      }
    },

    toDeclaration(name) {
      const params = buildParams()
      const block = b.blockStatement(config.body.map(toStmt))
      const fn = b.functionDeclaration(
        b.identifier(name),
        params,
        block,
        config.isGenerator
      )
      fn.async = config.isAsync
      if (config.returnType) {
        fn.returnType = b.tsTypeAnnotation(toTSType(config.returnType))
      }
      return fn
    },
  }
}

// =============================================================================
// Operators
// =============================================================================

type BinaryOp =
  | "==="
  | "!=="
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "in"
  | "instanceof"
  | "<<"
  | ">>"
  | ">>>"
  | "&"
  | "|"
  | "^"

type LogicalOp = "&&" | "||" | "??"

type UnaryOp = "!" | "-" | "+" | "typeof" | "void" | "delete" | "~"

type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "??=" | "||=" | "&&="

/**
 * Operator helpers for building expressions.
 */
const op = {
  /** Generic binary expression */
  binary: (left: n.Expression, operator: BinaryOp, right: n.Expression) =>
    b.binaryExpression(operator, toExpr(left), toExpr(right)),

  /** Logical expression (&&, ||, ??) */
  logical: (left: n.Expression, operator: LogicalOp, right: n.Expression) =>
    b.logicalExpression(operator, toExpr(left), toExpr(right)),

  /** Unary expression */
  unary: (operator: UnaryOp, argument: n.Expression) =>
    b.unaryExpression(operator, toExpr(argument)),

  /** Assignment expression */
  assign: (
    left: n.Identifier | n.MemberExpression | n.Pattern,
    operator: AssignOp,
    right: n.Expression
  ) =>
    b.assignmentExpression(operator, left as PatternKind, toExpr(right)),

  /** Ternary/conditional expression */
  ternary: (
    test: n.Expression,
    consequent: n.Expression,
    alternate: n.Expression
  ) => b.conditionalExpression(toExpr(test), toExpr(consequent), toExpr(alternate)),

  /** New expression */
  new: (callee: n.Expression, args: n.Expression[] = []) =>
    b.newExpression(toExpr(callee), args.map(toExpr)),

  // Common shortcuts
  /** Strict equality: `===` */
  eq: (left: n.Expression, right: n.Expression) =>
    b.binaryExpression("===", toExpr(left), toExpr(right)),

  /** Strict inequality: `!==` */
  neq: (left: n.Expression, right: n.Expression) =>
    b.binaryExpression("!==", toExpr(left), toExpr(right)),

  /** Logical not: `!` */
  not: (expr: n.Expression) => b.unaryExpression("!", toExpr(expr)),

  /** Logical and: `&&` */
  and: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("&&", toExpr(left), toExpr(right)),

  /** Logical or: `||` */
  or: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("||", toExpr(left), toExpr(right)),

  /** Nullish coalescing: `??` */
  nullish: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("??", toExpr(left), toExpr(right)),
} as const

// =============================================================================
// Statement Helpers
// =============================================================================

/**
 * Statement builders.
 */
const stmt = {
  /** `const name = init` */
  const: (name: string, init: n.Expression, type?: n.TSType) => {
    const id = b.identifier(name)
    if (type) {
      id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    }
    return b.variableDeclaration("const", [b.variableDeclarator(id, toExpr(init))])
  },

  /** `let name = init` */
  let: (name: string, init?: n.Expression, type?: n.TSType) => {
    const id = b.identifier(name)
    if (type) {
      id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    }
    return b.variableDeclaration("let", [
      b.variableDeclarator(id, init ? toExpr(init) : null),
    ])
  },

  /** `return expr` */
  return: (expr?: n.Expression) =>
    expr ? b.returnStatement(toExpr(expr)) : b.returnStatement(null),

  /** Expression statement: `expr;` */
  expr: (expr: n.Expression) => b.expressionStatement(toExpr(expr)),

  /** If statement */
  if: (
    test: n.Expression,
    consequent: n.Statement[],
    alternate?: n.Statement[]
  ) =>
    b.ifStatement(
      toExpr(test),
      b.blockStatement(consequent.map(toStmt)),
      alternate ? b.blockStatement(alternate.map(toStmt)) : null
    ),

  /** Throw statement */
  throw: (expr: n.Expression) => b.throwStatement(toExpr(expr)),

  /** Try-catch statement */
  try: (
    block: n.Statement[],
    catchParam: string,
    catchBlock: n.Statement[],
    finallyBlock?: n.Statement[]
  ) =>
    b.tryStatement(
      b.blockStatement(block.map(toStmt)),
      b.catchClause(
        b.identifier(catchParam),
        null,
        b.blockStatement(catchBlock.map(toStmt))
      ),
      finallyBlock ? b.blockStatement(finallyBlock.map(toStmt)) : null
    ),

  /** For...of statement */
  forOf: (
    varKind: "const" | "let",
    varName: string,
    iterable: n.Expression,
    body: n.Statement[]
  ) =>
    b.forOfStatement(
      b.variableDeclaration(varKind, [
        b.variableDeclarator(b.identifier(varName)),
      ]),
      toExpr(iterable),
      b.blockStatement(body.map(toStmt))
    ),

  /** Block statement */
  block: (...statements: n.Statement[]) =>
    b.blockStatement(statements.map(toStmt)),

  /** Async function declaration */
  asyncFn: (
    name: string,
    params: (n.Identifier | n.ObjectPattern)[],
    body: n.Statement[]
  ): n.FunctionDeclaration => {
    const fn = b.functionDeclaration(
      b.identifier(name),
      params,
      b.blockStatement(body.map(toStmt))
    )
    fn.async = true
    return fn
  },
} as const

// =============================================================================
// TypeScript Type Helpers
// =============================================================================

/**
 * TypeScript type node builders.
 */
const ts = {
  // Keyword types
  string: () => b.tsStringKeyword(),
  number: () => b.tsNumberKeyword(),
  boolean: () => b.tsBooleanKeyword(),
  bigint: () => b.tsBigIntKeyword(),
  any: () => b.tsAnyKeyword(),
  unknown: () => b.tsUnknownKeyword(),
  never: () => b.tsNeverKeyword(),
  void: () => b.tsVoidKeyword(),
  null: () => b.tsNullKeyword(),
  undefined: () => b.tsUndefinedKeyword(),

  /** Type reference: `TypeName` or `TypeName<T>` */
  ref: (name: string, typeParams?: n.TSType[]) => {
    const ref = b.tsTypeReference(b.identifier(name))
    if (typeParams && typeParams.length > 0) {
      ref.typeParameters = b.tsTypeParameterInstantiation(
        typeParams.map(toTSType)
      )
    }
    return ref
  },

  /** 
   * Qualified name reference: `Namespace.Type` or `Namespace.Nested.Type`
   * 
   * @param parts - Dot-separated path segments (e.g., "S", "Schema", "Type" for S.Schema.Type)
   *                or two strings for simple qualified names (e.g., "z", "infer")
   * @param typeParams - Optional type parameters
   */
  qualifiedRef: (first: string, second: string, typeParamsOrThird?: n.TSType[] | string, ...rest: string[]) => {
    let parts: string[];
    let typeParams: n.TSType[] | undefined;

    if (typeof typeParamsOrThird === "string") {
      // Called with multiple string parts: qualifiedRef("S", "Schema", "Type", ...)
      parts = [first, second, typeParamsOrThird, ...rest];
      typeParams = undefined;
    } else {
      // Called with two parts and optional type params: qualifiedRef("z", "infer", [typeParams])
      parts = [first, second];
      typeParams = typeParamsOrThird;
    }

    // Build nested qualified name from parts
    // e.g., ["S", "Schema", "Type"] -> S.Schema.Type
    let qualifiedName: n.Identifier | n.TSQualifiedName = b.identifier(parts[0]!);
    for (let i = 1; i < parts.length; i++) {
      qualifiedName = b.tsQualifiedName(qualifiedName, b.identifier(parts[i]!));
    }

    const ref = b.tsTypeReference(qualifiedName);
    if (typeParams && typeParams.length > 0) {
      ref.typeParameters = b.tsTypeParameterInstantiation(
        typeParams.map(toTSType)
      )
    }
    return ref
  },

  /**
   * Qualified name with type params after path: `S.Schema.Type<T>`
   * Use when you need both nested path AND type parameters.
   */
  qualifiedRefWithParams: (parts: string[], typeParams: n.TSType[]) => {
    let qualifiedName: n.Identifier | n.TSQualifiedName = b.identifier(parts[0]!);
    for (let i = 1; i < parts.length; i++) {
      qualifiedName = b.tsQualifiedName(qualifiedName, b.identifier(parts[i]!));
    }
    const ref = b.tsTypeReference(qualifiedName);
    if (typeParams.length > 0) {
      ref.typeParameters = b.tsTypeParameterInstantiation(
        typeParams.map(toTSType)
      )
    }
    return ref
  },

  /** Array type: `T[]` */
  array: (elementType: n.TSType) => b.tsArrayType(toTSType(elementType)),

  /** Union type: `A | B | C` */
  union: (...types: n.TSType[]) => b.tsUnionType(types.map(toTSType)),

  /** Intersection type: `A & B` */
  intersection: (...types: n.TSType[]) =>
    b.tsIntersectionType(types.map(toTSType)),

  /** Literal type: `"value"` or `42` */
  literal: (value: string | number | boolean) => {
    if (typeof value === "string") {
      return b.tsLiteralType(b.stringLiteral(value))
    } else if (typeof value === "number") {
      return b.tsLiteralType(b.numericLiteral(value))
    } else {
      return b.tsLiteralType(b.booleanLiteral(value))
    }
  },

  /** Tuple type: `[A, B, C]` */
  tuple: (...types: n.TSType[]) => b.tsTupleType(types.map(toTSType)),

  /** Function type: `(a: A, b: B) => R` */
  fn: (
    params: { name: string; type: n.TSType; optional?: boolean }[],
    returnType: n.TSType
  ) => {
    const fnParams: FnParamKind[] = params.map((p) => {
      const param = b.identifier(p.name)
      param.typeAnnotation = b.tsTypeAnnotation(toTSType(p.type))
      if (p.optional) {
        param.optional = true
      }
      return param as FnParamKind
    })
    const fnType = b.tsFunctionType(fnParams)
    fnType.typeAnnotation = b.tsTypeAnnotation(toTSType(returnType))
    return fnType
  },

  /** Typeof type: `typeof x` */
  typeof: (expr: string) => b.tsTypeQuery(b.identifier(expr)),

  /** Keyof type: `keyof T` */
  keyof: (type: n.TSType) =>
    ({
      type: "TSTypeOperator",
      operator: "keyof",
      typeAnnotation: toTSType(type),
    }) as n.TSTypeOperator,

  /** Readonly type: `readonly T` */
  readonly: (type: n.TSType) =>
    ({
      type: "TSTypeOperator",
      operator: "readonly",
      typeAnnotation: toTSType(type),
    }) as n.TSTypeOperator,

  /** Promise type: `Promise<T>` */
  promise: (inner: n.TSType) =>
    b.tsTypeReference(
      b.identifier("Promise"),
      b.tsTypeParameterInstantiation([toTSType(inner)])
    ),

  /**
   * Object type literal: `{ name: string; age?: number }`
   * @example
   * ts.objectType([
   *   { name: "id", type: ts.string() },
   *   { name: "count", type: ts.number(), optional: true },
   * ])
   */
  objectType: (props: { name: string; type: n.TSType; optional?: boolean; readonly?: boolean }[]) =>
    b.tsTypeLiteral(
      props.map(p => {
        const sig = b.tsPropertySignature(
          b.identifier(p.name),
          b.tsTypeAnnotation(toTSType(p.type))
        )
        if (p.optional) sig.optional = true
        if (p.readonly) sig.readonly = true
        return sig
      })
    ),

  /** Indexed access type: `T["key"]` or `T[K]` */
  indexedAccess: (objectType: n.TSType, indexType: n.TSType) =>
    b.tsIndexedAccessType(toTSType(objectType), toTSType(indexType)),
} as const

// =============================================================================
// Parameter Helpers
// =============================================================================

/**
 * Field descriptor for destructured parameters
 */
interface DestructuredField {
  readonly name: string
  readonly type: n.TSType
  readonly optional?: boolean
  readonly defaultValue?: n.Expression
}

/**
 * Parameter builders for function signatures.
 */
const param = {
  /**
   * Create a typed parameter: `name: Type`
   */
  typed: (name: string, type: n.TSType): n.Identifier => {
    const id = b.identifier(name)
    id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    return id
  },

  /**
   * Create an optional typed parameter: `name?: Type`
   */
  optional: (name: string, type: n.TSType): n.Identifier => {
    const id = b.identifier(name)
    id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    id.optional = true
    return id
  },

  /**
   * Create a parameter with default value: `name: Type = defaultValue`
   */
  withDefault: (name: string, defaultValue: n.Expression, type?: n.TSType): n.AssignmentPattern => {
    const id = b.identifier(name)
    if (type) {
      id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    }
    return b.assignmentPattern(id, toExpr(defaultValue))
  },

  /**
   * Create a destructured parameter with Pick type: `{ field }: Pick<Entity, 'field'>`
   * 
   * @example
   * param.pick(["id", "name"], "UserRow")
   * // { id, name }: Pick<UserRow, "id" | "name">
   */
  pick: (fields: readonly string[], entityType: string): n.ObjectPattern => {
    const pattern = b.objectPattern(
      fields.map((f) => {
        const prop = b.objectProperty(b.identifier(f), b.identifier(f))
        prop.shorthand = true
        return prop
      })
    )
    // Pick<Entity, 'field1' | 'field2'>
    const pickType = ts.ref("Pick", [
      ts.ref(entityType),
      fields.length === 1
        ? ts.literal(fields[0]!)
        : ts.union(...fields.map((f) => ts.literal(f))),
    ])
    pattern.typeAnnotation = b.tsTypeAnnotation(toTSType(pickType))
    return pattern
  },

  /**
   * Create a destructured parameter with explicit types and optional defaults.
   * 
   * @example
   * param.destructured([
   *   { name: "limit", type: ts.number(), optional: true, defaultValue: conjure.num(50) },
   *   { name: "offset", type: ts.number(), optional: true, defaultValue: conjure.num(0) },
   * ])
   * // { limit = 50, offset = 0 }: { limit?: number; offset?: number }
   */
  destructured: (fields: readonly DestructuredField[]): n.ObjectPattern => {
    const pattern = b.objectPattern(
      fields.map((f) => {
        const id = b.identifier(f.name)
        // Use AssignmentPattern for default values: { limit = 50 }
        const value = f.defaultValue
          ? b.assignmentPattern(id, toExpr(f.defaultValue))
          : id
        const prop = b.objectProperty(b.identifier(f.name), value)
        prop.shorthand = true
        return prop
      })
    )
    // Build the type annotation: { name: type; name?: type; }
    const typeAnnotation = ts.objectType(
      fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional }))
    )
    pattern.typeAnnotation = b.tsTypeAnnotation(toTSType(typeAnnotation))
    return pattern
  },
} as const

// =============================================================================
// Export Statement Helpers (conjure.export.*)
// =============================================================================

/**
 * Export statement builders for generating export declarations.
 * These produce plain statements without symbol metadata tracking.
 * For exports that need symbol tracking, use `exp.*` helpers instead.
 */
const exportHelpers = {
  /**
   * Export const declaration: `export const name = init`
   */
  const: (name: string, init: n.Expression, type?: n.TSType): n.ExportNamedDeclaration => {
    const id = b.identifier(name)
    if (type) {
      id.typeAnnotation = b.tsTypeAnnotation(toTSType(type))
    }
    const decl = b.variableDeclaration("const", [
      b.variableDeclarator(id, toExpr(init)),
    ])
    return b.exportNamedDeclaration(decl, [])
  },

  /**
   * Export function declaration: `export function name(...) { ... }`
   */
  fn: (fn: n.FunctionDeclaration): n.ExportNamedDeclaration => {
    return b.exportNamedDeclaration(fn, [])
  },

  /**
   * Export default: `export default expr`
   */
  default: (expr: n.Expression): n.ExportDefaultDeclaration => {
    return b.exportDefaultDeclaration(toExpr(expr) as ExpressionKind)
  },

  /**
   * Export named bindings: `export { a, b, c }`
   * Also supports renaming: `export { a as b }`
   */
  named: (...names: (string | { local: string; exported: string })[]): n.ExportNamedDeclaration => {
    const specifiers = names.map((n) => {
      if (typeof n === "string") {
        return b.exportSpecifier.from({
          local: b.identifier(n),
          exported: b.identifier(n),
        })
      } else {
        return b.exportSpecifier.from({
          local: b.identifier(n.local),
          exported: b.identifier(n.exported),
        })
      }
    })
    return b.exportNamedDeclaration(null, specifiers)
  },

  /**
   * Export type alias: `export type Name = Type`
   */
  type: (name: string, type: n.TSType): n.ExportNamedDeclaration => {
    const decl = b.tsTypeAliasDeclaration(b.identifier(name), toTSType(type))
    return b.exportNamedDeclaration(decl, [])
  },

  /**
   * Export interface: `export interface Name { ... }`
   */
  interface: (
    name: string,
    properties: { name: string; type: n.TSType; optional?: boolean; readonly?: boolean }[]
  ): n.ExportNamedDeclaration => {
    const members = properties.map((p): InterfaceBodyMember => {
      const sig = b.tsPropertySignature(
        b.identifier(p.name),
        b.tsTypeAnnotation(toTSType(p.type))
      )
      if (p.optional) sig.optional = true
      if (p.readonly) sig.readonly = true
      return sig
    })
    const decl = b.tsInterfaceDeclaration(
      b.identifier(name),
      b.tsInterfaceBody(members)
    )
    return b.exportNamedDeclaration(decl, [])
  },
} as const

// =============================================================================
// Export Helpers with Symbol Tracking (exp.*)
// =============================================================================

/**
 * Helper to create a SymbolStatement wrapper
 */
function symbolStatement(node: n.Statement, symbol: SymbolMeta): SymbolStatement {
  return { _tag: "SymbolStatement", node, symbol }
}

/**
 * Helper to create SymbolMeta with proper handling of optional shape
 */
function createSymbolMeta(
  name: string,
  ctx: SymbolContext,
  isType: boolean
): SymbolMeta {
  const base = {
    name,
    capability: ctx.capability,
    entity: ctx.entity,
    isType,
  }
  return ctx.shape !== undefined ? { ...base, shape: ctx.shape } : base
}

/**
 * TypeScript interface property signature
 */
interface TSPropertySignature {
  name: string
  type: n.TSType
  optional?: boolean
  readonly?: boolean
}

/**
 * Build interface properties from property signature objects
 */
function buildInterfaceProperties(props: TSPropertySignature[]): InterfaceBodyMember[] {
  return props.map((p): InterfaceBodyMember => {
    const sig = b.tsPropertySignature(
      b.identifier(p.name),
      b.tsTypeAnnotation(toTSType(p.type))
    )
    if (p.optional) sig.optional = true
    if (p.readonly) sig.readonly = true
    return sig
  })
}

/**
 * Export helpers that produce statements with symbol metadata.
 * These are used for tracking exports across files for import resolution.
 */
export const exp = {
  /**
   * Export interface declaration: `export interface Name { ... }`
   */
  interface: (
    name: string,
    ctx: SymbolContext,
    properties: TSPropertySignature[]
  ): SymbolStatement => {
    const decl = b.tsInterfaceDeclaration(
      b.identifier(name),
      b.tsInterfaceBody(buildInterfaceProperties(properties))
    )
    const exportDecl = b.exportNamedDeclaration(decl, [])
    return symbolStatement(exportDecl, createSymbolMeta(name, ctx, true))
  },

  /**
   * Export type alias: `export type Name = Type`
   */
  typeAlias: (
    name: string,
    ctx: SymbolContext,
    type: n.TSType
  ): SymbolStatement => {
    const decl = b.tsTypeAliasDeclaration(b.identifier(name), toTSType(type))
    const exportDecl = b.exportNamedDeclaration(decl, [])
    return symbolStatement(exportDecl, createSymbolMeta(name, ctx, true))
  },

  /**
   * Export const declaration: `export const name = init`
   */
  const: (
    name: string,
    ctx: SymbolContext,
    init: n.Expression,
    typeAnnotation?: n.TSType
  ): SymbolStatement => {
    const id = b.identifier(name)
    if (typeAnnotation) {
      id.typeAnnotation = b.tsTypeAnnotation(toTSType(typeAnnotation))
    }
    const decl = b.variableDeclaration("const", [
      b.variableDeclarator(id, toExpr(init)),
    ])
    const exportDecl = b.exportNamedDeclaration(decl, [])
    return symbolStatement(exportDecl, createSymbolMeta(name, ctx, false))
  },

  /**
   * Export type alias for inferred types: `export type Name = typeof schema`
   * Useful for exporting the inferred type alongside a schema constant.
   */
  type: (
    name: string,
    ctx: SymbolContext,
    type: n.TSType
  ): SymbolStatement => {
    // This is the same as typeAlias but semantically distinct -
    // used for inferred types like `z.infer<typeof Schema>`
    const decl = b.tsTypeAliasDeclaration(b.identifier(name), toTSType(type))
    const exportDecl = b.exportNamedDeclaration(decl, [])
    return symbolStatement(exportDecl, createSymbolMeta(name, ctx, true))
  },
} as const

// =============================================================================
// Program Builder
// =============================================================================

/**
 * Type guard for SymbolStatement
 */
function isSymbolStatement(
  stmt: n.Statement | SymbolStatement
): stmt is SymbolStatement {
  return (
    typeof stmt === "object" &&
    stmt !== null &&
    "_tag" in stmt &&
    stmt._tag === "SymbolStatement"
  )
}

/**
 * Create a SymbolProgram from statements, extracting symbol metadata.
 * Accepts both regular statements and SymbolStatements.
 */
function createSymbolProgram(
  ...statements: (n.Statement | SymbolStatement)[]
): SymbolProgram {
  const nodes: n.Statement[] = []
  const symbols: SymbolMeta[] = []

  for (const stmt of statements) {
    if (isSymbolStatement(stmt)) {
      nodes.push(stmt.node)
      symbols.push(stmt.symbol)
    } else {
      nodes.push(stmt)
    }
  }

  return {
    _tag: "SymbolProgram",
    node: b.program(nodes.map(toStmt)),
    symbols,
  }
}

// =============================================================================
// Main API
// =============================================================================

/**
 * Conjure - AST Builder DSL
 *
 * A fluent, immutable API for constructing JavaScript/TypeScript AST nodes.
 */
export const conjure = {
  // === Chain builders ===

  /** Start a chain from an identifier */
  id: (name: string) => createChain(b.identifier(name)),

  /** Start a chain from any expression */
  chain: (expr: n.Expression) => createChain(expr),

  // === Compound builders ===

  /** Start an object literal builder */
  obj: () => createObj(),

  /** Start an array literal builder */
  arr: (...elements: n.Expression[]) =>
    createArr(elements.map((e) => toExpr(e) as ArrayElementLike)),

  /** Start a function builder */
  fn: () =>
    createFn({
      params: [],
      body: [],
      returnType: null,
      isAsync: false,
      isArrow: false,
      isGenerator: false,
    }),

  // === Literals ===

  /** String literal */
  str: (value: string) => b.stringLiteral(value),

  /** Numeric literal */
  num: (value: number) => b.numericLiteral(value),

  /** Boolean literal */
  bool: (value: boolean) => b.booleanLiteral(value),

  /** null */
  null: () => b.nullLiteral(),

  /** undefined */
  undefined: () => b.identifier("undefined"),

  /** Template literal */
  template: (quasis: string[], ...expressions: n.Expression[]) => {
    const templateElements = quasis.map((raw, i) =>
      b.templateElement({ raw, cooked: raw }, i === quasis.length - 1)
    )
    return b.templateLiteral(templateElements, expressions.map(toExpr))
  },

  // === Operators ===
  op,

  // === Statements ===
  stmt,

  // === Export statements ===
  export: exportHelpers,

  /** Async function declaration */
  asyncFn: (name: string, params: (n.Identifier | n.ObjectPattern)[], body: n.Statement[]): n.FunctionDeclaration => {
    const fn = b.functionDeclaration(
      b.identifier(name),
      params,
      b.blockStatement(body.map(toStmt))
    )
    fn.async = true
    return fn
  },

  // === TypeScript types ===
  ts,

  // === Parameter helpers ===
  param,

  // === Export helpers ===
  exp,

  // === Helpers ===

  /** Await expression */
  await: (expr: n.Expression) => b.awaitExpression(toExpr(expr)),

  /** Spread expression (for use in arrays/calls) */
  spread: (expr: n.Expression) => b.spreadElement(toExpr(expr)),

  /** Print AST node to code string */
  print: (node: n.Node) => recast.print(node).code,

  /** Create a program from statements (backwards compatible) */
  program: (...statements: n.Statement[]) =>
    b.program(statements.map(toStmt)),

  /**
   * Create a SymbolProgram from statements, extracting symbol metadata.
   * Accepts both regular statements and SymbolStatements.
   * Returns a SymbolProgram with the AST node and extracted symbols.
   */
  symbolProgram: createSymbolProgram,

  // === Raw builders (escape hatch) ===

  /** Raw recast builders for advanced use cases */
  b,
} as const

export default conjure
