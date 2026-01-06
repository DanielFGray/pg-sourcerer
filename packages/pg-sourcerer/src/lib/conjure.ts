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

const b = recast.types.builders

// =============================================================================
// Type Casts
// =============================================================================

/**
 * Typed wrappers for recast AST nodes.
 *
 * The recast/ast-types library has type definitions that conflict with
 * exactOptionalPropertyTypes. These helpers provide safe casts for interop.
 */

/** Cast to expression for call arguments */
const asExpr = (node: n.Expression): any => node

/** Cast for member expression object */
const asMemberObj = (node: n.Expression): any => node

/** Cast for array elements (handles expressions and spreads) */
const asArrayElem = (node: n.Expression | n.SpreadElement): any => node

/** Cast for object property values */
const asPropValue = (node: n.Expression): any => node

/** Cast for statement arrays */
const asStatement = (node: n.Statement): any => node

/** Cast for TypeScript types */
const asTSType = (node: n.TSType): any => node

/**
 * Type cast helpers for raw recast interop.
 *
 * Use these when mixing conjure with direct recast builder calls.
 */
export const cast = {
  asExpr,
  asMemberObj,
  asArrayElem,
  asPropValue,
  asStatement,
  asTSType,
} as const

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
        b.memberExpression(asMemberObj(this.node), b.identifier(name))
      )
    },

    method(name, args = []) {
      return createChain(
        b.callExpression(
          b.memberExpression(asMemberObj(this.node), b.identifier(name)),
          args.map(asExpr)
        )
      )
    },

    call(args = []) {
      return createChain(
        b.callExpression(asMemberObj(this.node), args.map(asExpr))
      )
    },

    index(expr) {
      return createChain(
        b.memberExpression(asMemberObj(this.node), asExpr(expr), true)
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

  /** Add a computed property: `[key]: value` */
  computed(key: n.Expression, value: n.Expression): ObjBuilder

  /** Add a spread: `...expr` */
  spread(expr: n.Expression): ObjBuilder

  /** Add a shorthand property: `key` (where key is also the value identifier) */
  shorthand(key: string): ObjBuilder

  /** Finalize and return the object expression */
  build(): n.ObjectExpression
}

// Internal: use any[] to avoid exactOptionalPropertyTypes issues with recast
function createObj(props: any[] = []): ObjBuilder {
  return {
    prop(key, value) {
      return createObj([
        ...props,
        b.objectProperty(b.identifier(key), asPropValue(value)),
      ])
    },

    computed(key, value) {
      const prop = b.objectProperty(asExpr(key), asPropValue(value))
      prop.computed = true
      return createObj([...props, prop])
    },

    spread(expr) {
      return createObj([...props, b.spreadElement(asExpr(expr))])
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

// Internal: use any[] to avoid exactOptionalPropertyTypes issues
function createArr(elems: any[] = []): ArrBuilder {
  return {
    add(...exprs) {
      return createArr([...elems, ...exprs])
    },

    spread(expr) {
      return createArr([...elems, b.spreadElement(asExpr(expr))])
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
  const buildParams = (): any[] =>
    config.params.map((p) => {
      let param: any

      if (p.rest) {
        const restId = b.identifier(p.name)
        if (p.type) {
          restId.typeAnnotation = b.tsTypeAnnotation(asTSType(p.type))
        }
        param = b.restElement(restId)
      } else if (p.defaultValue) {
        // For default params, type annotation goes on the identifier
        const id = b.identifier(p.name)
        if (p.type) {
          id.typeAnnotation = b.tsTypeAnnotation(asTSType(p.type))
        }
        param = b.assignmentPattern(id, asExpr(p.defaultValue))
      } else {
        param = b.identifier(p.name)
        if (p.type) {
          param.typeAnnotation = b.tsTypeAnnotation(asTSType(p.type))
        }
        if (p.optional) {
          param.optional = true
        }
      }

      return param
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
      const block = b.blockStatement(config.body.map(asStatement))

      if (config.isArrow) {
        const fn = b.arrowFunctionExpression(params, block, false)
        fn.async = config.isAsync
        if (config.returnType) {
          fn.returnType = b.tsTypeAnnotation(asTSType(config.returnType))
        }
        return fn
      } else {
        const fn = b.functionExpression(null, params, block, config.isGenerator)
        fn.async = config.isAsync
        if (config.returnType) {
          fn.returnType = b.tsTypeAnnotation(asTSType(config.returnType))
        }
        return fn
      }
    },

    toDeclaration(name) {
      const params = buildParams()
      const block = b.blockStatement(config.body.map(asStatement))
      const fn = b.functionDeclaration(
        b.identifier(name),
        params,
        block,
        config.isGenerator
      )
      fn.async = config.isAsync
      if (config.returnType) {
        fn.returnType = b.tsTypeAnnotation(asTSType(config.returnType))
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
    b.binaryExpression(operator, asExpr(left), asExpr(right)),

  /** Logical expression (&&, ||, ??) */
  logical: (left: n.Expression, operator: LogicalOp, right: n.Expression) =>
    b.logicalExpression(operator, asExpr(left), asExpr(right)),

  /** Unary expression */
  unary: (operator: UnaryOp, argument: n.Expression) =>
    b.unaryExpression(operator, asExpr(argument)),

  /** Assignment expression */
  assign: (left: n.Expression, operator: AssignOp, right: n.Expression) =>
    b.assignmentExpression(operator, asExpr(left), asExpr(right)),

  /** Ternary/conditional expression */
  ternary: (
    test: n.Expression,
    consequent: n.Expression,
    alternate: n.Expression
  ) => b.conditionalExpression(asExpr(test), asExpr(consequent), asExpr(alternate)),

  /** New expression */
  new: (callee: n.Expression, args: n.Expression[] = []) =>
    b.newExpression(asMemberObj(callee), args.map(asExpr)),

  // Common shortcuts
  /** Strict equality: `===` */
  eq: (left: n.Expression, right: n.Expression) =>
    b.binaryExpression("===", asExpr(left), asExpr(right)),

  /** Strict inequality: `!==` */
  neq: (left: n.Expression, right: n.Expression) =>
    b.binaryExpression("!==", asExpr(left), asExpr(right)),

  /** Logical not: `!` */
  not: (expr: n.Expression) => b.unaryExpression("!", asExpr(expr)),

  /** Logical and: `&&` */
  and: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("&&", asExpr(left), asExpr(right)),

  /** Logical or: `||` */
  or: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("||", asExpr(left), asExpr(right)),

  /** Nullish coalescing: `??` */
  nullish: (left: n.Expression, right: n.Expression) =>
    b.logicalExpression("??", asExpr(left), asExpr(right)),
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
      id.typeAnnotation = b.tsTypeAnnotation(asTSType(type))
    }
    return b.variableDeclaration("const", [b.variableDeclarator(id, asExpr(init))])
  },

  /** `let name = init` */
  let: (name: string, init?: n.Expression, type?: n.TSType) => {
    const id = b.identifier(name)
    if (type) {
      id.typeAnnotation = b.tsTypeAnnotation(asTSType(type))
    }
    return b.variableDeclaration("let", [
      b.variableDeclarator(id, init ? asExpr(init) : null),
    ])
  },

  /** `return expr` */
  return: (expr?: n.Expression) =>
    expr ? b.returnStatement(asExpr(expr)) : b.returnStatement(null),

  /** Expression statement: `expr;` */
  expr: (expr: n.Expression) => b.expressionStatement(asExpr(expr)),

  /** If statement */
  if: (
    test: n.Expression,
    consequent: n.Statement[],
    alternate?: n.Statement[]
  ) =>
    b.ifStatement(
      asExpr(test),
      b.blockStatement(consequent.map(asStatement)),
      alternate ? b.blockStatement(alternate.map(asStatement)) : null
    ),

  /** Throw statement */
  throw: (expr: n.Expression) => b.throwStatement(asExpr(expr)),

  /** Try-catch statement */
  try: (
    block: n.Statement[],
    catchParam: string,
    catchBlock: n.Statement[],
    finallyBlock?: n.Statement[]
  ) =>
    b.tryStatement(
      b.blockStatement(block.map(asStatement)),
      b.catchClause(
        b.identifier(catchParam),
        null,
        b.blockStatement(catchBlock.map(asStatement))
      ),
      finallyBlock ? b.blockStatement(finallyBlock.map(asStatement)) : null
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
      asExpr(iterable),
      b.blockStatement(body.map(asStatement))
    ),

  /** Block statement */
  block: (...statements: n.Statement[]) =>
    b.blockStatement(statements.map(asStatement)),
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
        typeParams.map(asTSType)
      )
    }
    return ref
  },

  /** Qualified name reference: `Namespace.Type` */
  qualifiedRef: (qualifier: string, name: string, typeParams?: n.TSType[]) => {
    const ref = b.tsTypeReference(
      b.tsQualifiedName(b.identifier(qualifier), b.identifier(name))
    )
    if (typeParams && typeParams.length > 0) {
      ref.typeParameters = b.tsTypeParameterInstantiation(
        typeParams.map(asTSType)
      )
    }
    return ref
  },

  /** Array type: `T[]` */
  array: (elementType: n.TSType) => b.tsArrayType(asTSType(elementType)),

  /** Union type: `A | B | C` */
  union: (...types: n.TSType[]) => b.tsUnionType(types.map(asTSType)),

  /** Intersection type: `A & B` */
  intersection: (...types: n.TSType[]) =>
    b.tsIntersectionType(types.map(asTSType)),

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
  tuple: (...types: n.TSType[]) => b.tsTupleType(types.map(asTSType)),

  /** Function type: `(a: A, b: B) => R` */
  fn: (
    params: Array<{ name: string; type: n.TSType; optional?: boolean }>,
    returnType: n.TSType
  ) => {
    const fnParams = params.map((p) => {
      const param: any = b.identifier(p.name)
      param.typeAnnotation = b.tsTypeAnnotation(asTSType(p.type))
      if (p.optional) {
        param.optional = true
      }
      return param
    })
    const fnType = b.tsFunctionType(fnParams)
    fnType.typeAnnotation = b.tsTypeAnnotation(asTSType(returnType))
    return fnType
  },

  /** Typeof type: `typeof x` */
  typeof: (expr: string) => b.tsTypeQuery(b.identifier(expr)),

  /** Keyof type: `keyof T` */
  keyof: (type: n.TSType) =>
    ({
      type: "TSTypeOperator",
      operator: "keyof",
      typeAnnotation: asTSType(type),
    }) as n.TSTypeOperator,

  /** Readonly type: `readonly T` */
  readonly: (type: n.TSType) =>
    ({
      type: "TSTypeOperator",
      operator: "readonly",
      typeAnnotation: asTSType(type),
    }) as n.TSTypeOperator,
} as const

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
  arr: (...elements: n.Expression[]) => createArr(elements),

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
    return b.templateLiteral(templateElements, expressions.map(asExpr))
  },

  // === Operators ===
  op,

  // === Statements ===
  stmt,

  // === TypeScript types ===
  ts,

  // === Helpers ===

  /** Await expression */
  await: (expr: n.Expression) => b.awaitExpression(asExpr(expr)),

  /** Spread expression (for use in arrays/calls) */
  spread: (expr: n.Expression) => b.spreadElement(asExpr(expr)),

  /** Print AST node to code string */
  print: (node: n.Node) => recast.print(node).code,

  /** Create a program from statements */
  program: (...statements: n.Statement[]) =>
    b.program(statements.map(asStatement)),

  // === Raw builders (escape hatch) ===

  /** Raw recast builders for advanced use cases */
  b,
} as const

export default conjure
