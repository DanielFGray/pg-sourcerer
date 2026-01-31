---
sidebar_position: 3
---

# Statements

Statements perform actions and control flow in your generated code.

## Variable Declarations

### Const

```typescript
conjure.stmt.const(
  "user",
  conjure.obj().prop("id", conjure.num(1)).build()
)
// const user = { id: 1 };
```

With type annotation:

```typescript
conjure.stmt.const(
  "count",
  conjure.num(0),
  conjure.ts.number()
)
// const count: number = 0;
```

### Let

```typescript
conjure.stmt.let("result")
// let result;

conjure.stmt.let(
  "result",
  conjure.null(),
  conjure.ts.union(conjure.ts.string(), conjure.ts.null())
)
// let result: string | null = null;
```

## Control Flow

### Return

```typescript
conjure.stmt.return(conjure.id("value"))
// return value;

conjure.stmt.return()
// return;
```

### If Statement

```typescript
conjure.stmt.if(
  conjure.id("isValid"),
  [
    conjure.stmt.return(conjure.bool(true))
  ]
)
// if (isValid) {
//   return true;
// }
```

With else:

```typescript
conjure.stmt.if(
  conjure.op.eq(conjure.id("status"), conjure.num(200)),
  [
    conjure.stmt.return(conjure.id("data"))
  ],
  [
    conjure.stmt.throw(
      conjure.op.new(conjure.id("Error"), [conjure.str("Failed")])
    )
  ]
)
// if (status === 200) {
//   return data;
// } else {
//   throw new Error("Failed");
// }
```

### For...of

```typescript
conjure.stmt.forOf(
  "const",
  "item",
  conjure.id("items"),
  [
    conjure.stmt.expr(
      conjure.call("console", "log", [conjure.id("item")])
    )
  ]
)
// for (const item of items) {
//   console.log(item);
// }
```

## Error Handling

### Throw

```typescript
conjure.stmt.throw(
  conjure.op.new(
    conjure.id("Error"),
    [conjure.str("Not found")]
  )
)
// throw new Error("Not found");
```

### Try-Catch

```typescript
conjure.stmt.try(
  // try block
  [
    conjure.stmt.const(
      "data",
      conjure.await(conjure.call("fetch", "json", []))
    )
  ],
  // catch param
  "error",
  // catch block
  [
    conjure.stmt.expr(
      conjure.call("console", "error", [conjure.id("error")])
    )
  ],
  // finally (optional)
  [
    conjure.stmt.expr(
      conjure.call("cleanup", [])
    )
  ]
)
// try {
//   const data = await fetch.json();
// } catch (error) {
//   console.error(error);
// } finally {
//   cleanup();
// }
```

## Expression Statements

Use `stmt.expr()` to turn an expression into a statement:

```typescript
conjure.stmt.expr(
  conjure.call("console", "log", [conjure.str("Hello")])
)
// console.log("Hello");
```

## Block Statements

```typescript
conjure.stmt.block(
  conjure.stmt.const("x", conjure.num(1)),
  conjure.stmt.const("y", conjure.num(2)),
  conjure.stmt.return(conjure.op.binary(conjure.id("x"), "+", conjure.id("y")))
)
// {
//   const x = 1;
//   const y = 2;
//   return x + y;
// }
```

## Async Function Declarations

Quick helper for async functions:

```typescript
conjure.asyncFn(
  "fetchUser",
  [conjure.param.typed("id", conjure.ts.string())],
  [
    conjure.stmt.const(
      "response",
      conjure.await(
        conjure.call("fetch", [
          conjure.template(["/users/", ""], [conjure.id("id")])
        ])
      )
    ),
    conjure.stmt.return(
      conjure.await(conjure.id("response").method("json").build())
    )
  ]
)
// async function fetchUser(id: string) {
//   const response = await fetch(`/users/${id}`);
//   return await response.json();
// }
```
