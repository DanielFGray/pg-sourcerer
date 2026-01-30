---
sidebar_position: 5
---

# Functions & Parameters

Build function expressions and declarations with typed parameters.

## Function Builder

The function builder creates both function expressions and declarations.

### Basic Function

```typescript
conjure.fn()
  .param("x")
  .param("y")
  .body(
    conjure.stmt.return(
      conjure.op.binary(conjure.id("x"), "+", conjure.id("y"))
    )
  )
  .build()
// function(x, y) {
//   return x + y;
// }
```

### Arrow Function

```typescript
conjure.fn()
  .param("id", conjure.ts.string())
  .returns(conjure.ts.ref("User"))
  .body(
    conjure.stmt.return(conjure.call("findUser", [conjure.id("id")]))
  )
  .arrow()
  .build()
// (id: string): User => {
//   return findUser(id);
// }
```

### Async Function

```typescript
conjure.fn()
  .async()
  .arrow()
  .param("url", conjure.ts.string())
  .returns(conjure.ts.promise(conjure.ts.ref("Response")))
  .body(
    conjure.stmt.return(
      conjure.await(conjure.call("fetch", [conjure.id("url")]))
    )
  )
  .build()
// async (url: string): Promise<Response> => {
//   return await fetch(url);
// }
```

### Generator Function

```typescript
conjure.fn()
  .generator()
  .param("n", conjure.ts.number())
  .body(
    conjure.stmt.forOf(
      "let",
      "i",
      conjure.call("Array", [conjure.id("n")]),
      [
        conjure.stmt.expr(
          conjure.id("yield").call([conjure.id("i")])
        )
      ]
    )
  )
  .build()
// function*(n: number) {
//   for (let i of Array(n)) {
//     yield i;
//   }
// }
```

### Function Declaration

```typescript
conjure.fn()
  .param("name", conjure.ts.string())
  .body(
    conjure.stmt.expr(
      conjure.call("console", "log", [conjure.id("name")])
    )
  )
  .toDeclaration("greet")
// function greet(name: string) {
//   console.log(name);
// }
```

## Parameters

### Typed Parameters

```typescript
conjure.param.typed("id", conjure.ts.string())
// id: string
```

### Optional Parameters

```typescript
conjure.param.optional("count", conjure.ts.number())
// count?: number

// Or via function builder
conjure.fn()
  .optionalParam("limit", conjure.ts.number())
  .build()
```

### Parameters with Defaults

```typescript
conjure.param.withDefault(
  "limit",
  conjure.num(50),
  conjure.ts.number()
)
// limit: number = 50

// Or via function builder
conjure.fn()
  .defaultParam("limit", conjure.num(50), conjure.ts.number())
  .build()
```

### Rest Parameters

```typescript
conjure.fn()
  .restParam("args", conjure.ts.array(conjure.ts.string()))
  .build()
// (...args: string[]) => { ... }
```

## Destructured Parameters

### Simple Destructuring with Pick

For extracting specific fields from a type:

```typescript
conjure.param.pick(
  ["id", "email"],
  "User"
)
// { id, email }: Pick<User, "id" | "email">
```

### Explicit Destructured Types

With optional fields and defaults:

```typescript
conjure.param.destructured([
  { name: "limit", type: conjure.ts.number(), optional: true, defaultValue: conjure.num(50) },
  { name: "offset", type: conjure.ts.number(), optional: true, defaultValue: conjure.num(0) }
])
// { limit = 50, offset = 0 }: { limit?: number; offset?: number }
```

### Destructuring with Rest

Combine specific fields with a rest parameter:

```typescript
conjure.param.withRest(
  [{ name: "id", type: conjure.ts.string() }],
  "data",
  conjure.ts.ref("Updateable", [conjure.ts.ref("User")])
)
// { id, ...data }: { id: string } & Updateable<User>
```

## Complete Example

Building a complex query function:

```typescript
const findUserById = conjure.fn()
  .async()
  .arrow()
  .rawParam(
    conjure.param.destructured([
      { name: "id", type: conjure.ts.string() }
    ])
  )
  .returns(
    conjure.ts.promise(
      conjure.ts.union(
        conjure.ts.ref("User"),
        conjure.ts.undefined()
      )
    )
  )
  .body(
    conjure.stmt.return(
      conjure.await(
        conjure.id("db")
          .method("selectFrom", [conjure.str("users")])
          .method("where", [
            conjure.str("id"),
            conjure.str("="),
            conjure.id("id")
          ])
          .method("executeTakeFirst")
          .build()
      )
    )
  )
  .build();

// async ({ id }: { id: string }): Promise<User | undefined> => {
//   return await db
//     .selectFrom("users")
//     .where("id", "=", id)
//     .executeTakeFirst();
// }
```

## Export as Const

Wrap in an export for a named function:

```typescript
conjure.export.const(
  "findById",
  conjure.fn()
    .async()
    .arrow()
    .param("id", conjure.ts.string())
    .body(/* ... */)
    .build()
)
// export const findById = async (id: string) => { ... };
```
