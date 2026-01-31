---
sidebar_position: 8
---

# Quick Reference

A concise cheatsheet for the Conjure API.

## Expressions

| Pattern | Code |
|---------|------|
| Identifier | `conjure.id("name")` |
| String | `conjure.str("hello")` |
| Number | `conjure.num(42)` |
| Boolean | `conjure.bool(true)` |
| null/undefined | `conjure.null()` / `conjure.undefined()` |
| Method chain | `conjure.id("z").method("string").build()` |
| Property access | `conjure.id("user").prop("email").build()` |
| Call | `conjure.id("fn").call([arg1, arg2]).build()` |
| Object | `conjure.obj().prop("x", val).build()` |
| Array | `conjure.arr(el1, el2).build()` |
| Await | `conjure.await(expr)` |
| Spread | `conjure.spread(expr)` |
| Template | `conjure.template(["Hello ", "!"], [name])` |

## Statements

| Pattern | Code |
|---------|------|
| const | `conjure.stmt.const("x", init, type)` |
| let | `conjure.stmt.let("x", init, type)` |
| return | `conjure.stmt.return(expr)` |
| if | `conjure.stmt.if(test, thenBlock, elseBlock)` |
| for...of | `conjure.stmt.forOf("const", "item", iter, body)` |
| throw | `conjure.stmt.throw(expr)` |
| try-catch | `conjure.stmt.try(block, param, catchBlock, finally)` |
| expression | `conjure.stmt.expr(expr)` |

## TypeScript Types

| Pattern | Code |
|---------|------|
| Primitives | `conjure.ts.string()` / `number()` / `boolean()` |
| Type ref | `conjure.ts.ref("User")` |
| With params | `conjure.ts.ref("Array", [conjure.ts.string()])` |
| Qualified | `conjure.ts.qualifiedRef("z", "infer", [typeParams])` |
| Array | `conjure.ts.array(type)` |
| Union | `conjure.ts.union(type1, type2, ...)` |
| Intersection | `conjure.ts.intersection(type1, type2)` |
| Nullable | `conjure.ts.nullable(type)` |
| Literal | `conjure.ts.literal("value")` |
| Object | `conjure.ts.objectType([{name, type, optional}])` |
| Function | `conjure.ts.fn([{name, type}], returnType)` |
| typeof | `conjure.ts.typeof("varName")` |
| keyof | `conjure.ts.keyof(type)` |
| Promise | `conjure.ts.promise(type)` |

## Functions

```typescript
conjure.fn()
  .async()                              // Make async
  .arrow()                              // Arrow function
  .generator()                          // Generator function
  .param("x", type)                     // Required param
  .optionalParam("y", type)             // Optional param
  .defaultParam("z", defaultVal, type)  // Param with default
  .restParam("args", type)              // Rest param
  .returns(type)                        // Return type
  .body(...statements)                  // Function body
  .build()                              // Build expression
  .toDeclaration("name")                // Build declaration
```

## Parameters

```typescript
// Simple typed
conjure.param.typed("id", conjure.ts.string())

// Optional
conjure.param.optional("count", conjure.ts.number())

// With default
conjure.param.withDefault("limit", conjure.num(50), conjure.ts.number())

// Destructured with Pick
conjure.param.pick(["id", "email"], "User")

// Destructured with explicit types
conjure.param.destructured([
  { name: "limit", type: conjure.ts.number(), optional: true }
])

// Destructured with rest
conjure.param.withRest(
  [{ name: "id", type: conjure.ts.string() }],
  "data",
  conjure.ts.ref("UpdateType")
)
```

## Imports

```typescript
// Named
conjure.import.named("source", "a", "b", "c")

// Renamed
conjure.import.named("source", { imported: "x", local: "y" })

// Default
conjure.import.default("source", "name")

// Namespace
conjure.import.namespace("source", "name")

// Side-effect
conjure.import.sideEffect("./file.js")
```

## Exports (Basic)

```typescript
// Const
conjure.export.const("NAME", init, type)

// Function
conjure.export.fn(functionDeclaration)

// Default
conjure.export.default(expr)

// Named
conjure.export.named("a", "b")

// Type
conjure.export.type("Name", type)

// Interface
conjure.export.interface("Name", [{name, type, optional}])
```

## Operators

```typescript
// Binary
conjure.op.binary(left, "+", right)

// Logical
conjure.op.logical(left, "&&", right)

// Shortcuts
conjure.op.eq(a, b)          // a === b
conjure.op.neq(a, b)         // a !== b
conjure.op.not(expr)         // !expr
conjure.op.and(a, b)         // a && b
conjure.op.or(a, b)          // a || b
conjure.op.nullish(a, b)     // a ?? b

// Ternary
conjure.op.ternary(test, consequent, alternate)

// Assignment
conjure.op.assign(left, "=", right)

// New
conjure.op.new(callee, [args])
```

## Programs

```typescript
// Basic program
conjure.program(...statements)
```

## Printing

```typescript
const code = conjure.print(astNode);
```

## Cast (Recast Interop)

```typescript
// Cast to recast Expression
const expr = conjure.cast.toExpr(node);

// Cast to array element (Expression | SpreadElement)
const elem = conjure.cast.asArrayElem(node);

// Cast to recast Statement
const stmt = conjure.cast.toStmt(node);

// Cast to TypeScript type node
const type = conjure.cast.toTSType(node);
```

## Complete Example

```typescript
import { conjure, symbol } from "@danielfgray/pg-sourcerer";

// Build schema expression
const schema = conjure.id("z")
  .method("object")
  .call([
    conjure.obj()
      .prop("id", conjure.call("z", "string"))
      .prop("email", conjure.call("z", "string"))
      .build()
  ])
  .build();

// Create export nodes
const schemaExport = conjure.export.const("UserSchema", schema);
const typeExport = conjure.export.type(
  "User",
  conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof("UserSchema")])
);

// Track symbols
const symbols = [
  symbol({
    name: "UserSchema",
    capability: "zod:schema:users:row",
    node: schemaExport,
    exports: "named",
  }),
  symbol({
    name: "User",
    capability: "zod:types:users:row",
    node: typeExport,
    exports: "named",
  }),
];

// Build program
const program = conjure.program(
  conjure.import.named("zod", "z"),
  schemaExport,
  typeExport
);

// Print to code
const code = conjure.print(program);
// Symbols available in the array for registration
```
