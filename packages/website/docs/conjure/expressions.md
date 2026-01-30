---
sidebar_position: 2
---

# Expressions

Expressions are the building blocks of your generated code. They produce values.

## Literals

### Basic Literals

```typescript
conjure.str("hello")        // "hello"
conjure.num(42)             // 42
conjure.bool(true)          // true
conjure.null()              // null
conjure.undefined()         // undefined
```

### Template Literals

```typescript
conjure.template(
  ["Hello ", ", welcome!"],
  conjure.id("name")
)
// `Hello ${name}, welcome!`
```

### Tagged Templates

```typescript
// sql`SELECT * FROM users WHERE id = ${id}`
conjure.taggedTemplate(
  "sql",
  ["SELECT * FROM users WHERE id = ", ""],
  [conjure.id("id")]
)

// With type parameters: sql<User>`SELECT * FROM users`
conjure.taggedTemplate(
  "sql",
  ["SELECT * FROM users"],
  [],
  [conjure.ts.ref("User")]
)
```

## Identifiers & Chains

### Simple Identifiers

```typescript
conjure.id("myVar")  // myVar
```

### Method Chains

```typescript
conjure.id("z")
  .method("string")
  .method("uuid")
  .build()
// z.string().uuid()
```

### Property Access

```typescript
conjure.id("user")
  .prop("profile")
  .prop("email")
  .build()
// user.profile.email
```

### Method Calls with Arguments

```typescript
conjure.id("db")
  .method("selectFrom", [conjure.str("users")])
  .method("where", [
    conjure.str("id"),
    conjure.str("="),
    conjure.id("userId")
  ])
  .build()
// db.selectFrom("users").where("id", "=", userId)
```

### Direct Calls

```typescript
conjure.id("fetch")
  .call([conjure.str("/api/users")])
  .build()
// fetch("/api/users")
```

### Computed Access

```typescript
conjure.id("obj")
  .index(conjure.str("key"))
  .build()
// obj["key"]
```

### Quick Method Call Helper

```typescript
// Shorthand for simple method calls
conjure.call("db", "selectFrom", [conjure.str("users")])
// db.selectFrom("users")
```

## Objects

```typescript
conjure.obj()
  .prop("name", conjure.str("John"))
  .prop("age", conjure.num(30))
  .prop("active", conjure.bool(true))
  .build()
// { name: "John", age: 30, active: true }
```

### String Keys (for special characters)

```typescript
conjure.obj()
  .stringProp("first-name", conjure.str("John"))
  .build()
// { "first-name": "John" }
```

### Computed Properties

```typescript
conjure.obj()
  .computed(conjure.id("key"), conjure.str("value"))
  .build()
// { [key]: "value" }
```

### Spread Properties

```typescript
conjure.obj()
  .prop("id", conjure.num(1))
  .spread(conjure.id("rest"))
  .build()
// { id: 1, ...rest }
```

### Shorthand Properties

```typescript
conjure.obj()
  .shorthand("name")
  .shorthand("email")
  .build()
// { name, email }
```

### From Entries

```typescript
const entries: [string, n.Expression][] = [
  ["name", conjure.str("Alice")],
  ["age", conjure.num(25)]
];

conjure.obj()
  .fromEntries(entries)
  .build()
// { name: "Alice", age: 25 }
```

## Arrays

```typescript
conjure.arr(
  conjure.num(1),
  conjure.num(2),
  conjure.num(3)
).build()
// [1, 2, 3]
```

### Adding Elements

```typescript
conjure.arr()
  .add(conjure.str("a"))
  .add(conjure.str("b"), conjure.str("c"))
  .build()
// ["a", "b", "c"]
```

### Spread Elements

```typescript
conjure.arr()
  .add(conjure.num(1))
  .spread(conjure.id("rest"))
  .add(conjure.num(5))
  .build()
// [1, ...rest, 5]
```

### Direct Array Expression

```typescript
// Shorthand that skips the builder
conjure.arrExpr(
  conjure.num(1),
  conjure.num(2)
)
// [1, 2]
```

## Operators

### Binary Operators

```typescript
conjure.op.binary(
  conjure.id("a"),
  "+",
  conjure.id("b")
)
// a + b
```

Supported operators: `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `+`, `-`, `*`, `/`, `%`, `**`, `in`, `instanceof`, `<<`, `>>`, `>>>`, `&`, `|`, `^`

### Logical Operators

```typescript
conjure.op.logical(
  conjure.id("isValid"),
  "&&",
  conjure.id("isActive")
)
// isValid && isActive
```

### Common Shortcuts

```typescript
conjure.op.eq(a, b)          // a === b
conjure.op.neq(a, b)         // a !== b
conjure.op.not(expr)         // !expr
conjure.op.and(a, b)         // a && b
conjure.op.or(a, b)          // a || b
conjure.op.nullish(a, b)     // a ?? b
```

### Ternary/Conditional

```typescript
conjure.op.ternary(
  conjure.id("condition"),
  conjure.str("yes"),
  conjure.str("no")
)
// condition ? "yes" : "no"
```

### Assignment

```typescript
conjure.op.assign(
  conjure.id("x"),
  "=",
  conjure.num(42)
)
// x = 42
```

Assignment operators: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `??=`, `||=`, `&&=`

### New Expression

```typescript
conjure.op.new(
  conjure.id("User"),
  [conjure.str("Alice")]
)
// new User("Alice")
```

## Other Helpers

### Await

```typescript
conjure.await(
  conjure.call("fetch", "json", [])
)
// await fetch.json()
```

### Non-null Assertion

```typescript
conjure.nonNull(conjure.id("maybeValue"))
// maybeValue!
```

### Spread Expression

```typescript
conjure.spread(conjure.id("items"))
// ...items
```
