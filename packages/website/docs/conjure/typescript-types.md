---
sidebar_position: 4
---

# TypeScript Types

Build TypeScript type annotations for your generated code.

## Keyword Types

```typescript
conjure.ts.string()      // string
conjure.ts.number()      // number
conjure.ts.boolean()     // boolean
conjure.ts.bigint()      // bigint
conjure.ts.any()         // any
conjure.ts.unknown()     // unknown
conjure.ts.never()       // never
conjure.ts.void()        // void
conjure.ts.null()        // null
conjure.ts.undefined()   // undefined
```

## Type References

### Simple References

```typescript
conjure.ts.ref("User")
// User

conjure.ts.ref("Array", [conjure.ts.string()])
// Array<string>
```

### Qualified References

For namespaced types like `z.infer`:

```typescript
conjure.ts.qualifiedRef("z", "infer")
// z.infer

conjure.ts.qualifiedRef(
  "z",
  "infer",
  [conjure.ts.typeof("UserSchema")]
)
// z.infer<typeof UserSchema>
```

For deeper nesting like `S.Schema.Type`:

```typescript
conjure.ts.qualifiedRef("S", "Schema", "Type")
// S.Schema.Type

// With type params
conjure.ts.qualifiedRefWithParams(
  ["S", "Schema", "Type"],
  [conjure.ts.ref("User")]
)
// S.Schema.Type<User>
```

## Composite Types

### Arrays

```typescript
conjure.ts.array(conjure.ts.string())
// string[]

conjure.ts.asArray(conjure.ts.ref("User"))
// User[]
```

### Unions

```typescript
conjure.ts.union(
  conjure.ts.string(),
  conjure.ts.number(),
  conjure.ts.null()
)
// string | number | null
```

### Intersections

```typescript
conjure.ts.intersection(
  conjure.ts.ref("User"),
  conjure.ts.ref("Timestamps")
)
// User & Timestamps
```

### Tuples

```typescript
conjure.ts.tuple(
  conjure.ts.string(),
  conjure.ts.number(),
  conjure.ts.boolean()
)
// [string, number, boolean]
```

## Literal Types

```typescript
conjure.ts.literal("active")     // "active"
conjure.ts.literal(42)           // 42
conjure.ts.literal(true)         // true
```

## Object Types

```typescript
conjure.ts.objectType([
  { name: "id", type: conjure.ts.string() },
  { name: "count", type: conjure.ts.number(), optional: true },
  { name: "readonly", type: conjure.ts.boolean(), readonly: true }
])
// { id: string; count?: number; readonly readonly: boolean }
```

## Function Types

```typescript
conjure.ts.fn(
  [
    { name: "id", type: conjure.ts.string() },
    { name: "options", type: conjure.ts.ref("Options"), optional: true }
  ],
  conjure.ts.promise(conjure.ts.ref("User"))
)
// (id: string, options?: Options) => Promise<User>
```

## Type Operators

### Typeof

```typescript
conjure.ts.typeof("mySchema")
// typeof mySchema
```

### Keyof

```typescript
conjure.ts.keyof(conjure.ts.ref("User"))
// keyof User
```

### Readonly

```typescript
conjure.ts.readonly(conjure.ts.array(conjure.ts.string()))
// readonly string[]
```

### Indexed Access

```typescript
conjure.ts.indexedAccess(
  conjure.ts.ref("User"),
  conjure.ts.literal("email")
)
// User["email"]
```

## Utility Types

### Promise

```typescript
conjure.ts.promise(conjure.ts.ref("User"))
// Promise<User>
```

### Nullable

```typescript
conjure.ts.nullable(conjure.ts.string())
// string | null
```

## Type Modifiers

Apply modifiers in a specific order (array first, then nullable):

```typescript
conjure.ts.withModifiers(
  conjure.ts.string(),
  { array: true, nullable: true }
)
// string[] | null
```

## Parse Type Strings

For simple cases, parse a string:

```typescript
conjure.ts.fromString("string")      // string
conjure.ts.fromString("Date")        // Date
conjure.ts.fromString("string[]")    // string[]
conjure.ts.fromString("User")        // User (type reference)
```

Handles primitives, built-ins (Date, Buffer), array suffix, and custom types.

## Usage in Declarations

### Variable with Type

```typescript
conjure.stmt.const(
  "users",
  conjure.arr().build(),
  conjure.ts.array(conjure.ts.ref("User"))
)
// const users: User[] = [];
```

### Function Parameters

```typescript
conjure.fn()
  .param("id", conjure.ts.string())
  .param("options", conjure.ts.ref("Options"))
  .returns(conjure.ts.promise(conjure.ts.ref("User")))
  .body(/* ... */)
  .arrow()
  .build()
// (id: string, options: Options): Promise<User> => { ... }
```

### Type Alias

```typescript
conjure.export.type(
  "UserId",
  conjure.ts.string()
)
// export type UserId = string;
```

### Interface

```typescript
conjure.export.interface(
  "User",
  [
    { name: "id", type: conjure.ts.string() },
    { name: "email", type: conjure.ts.string() },
    { name: "role", type: conjure.ts.ref("UserRole"), optional: true }
  ]
)
// export interface User {
//   id: string;
//   email: string;
//   role?: UserRole;
// }
```
