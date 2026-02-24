---
sidebar_position: 1
---

# Introduction to Conjure

Conjure is pg-sourcerer's fluent, immutable API for building JavaScript/TypeScript AST (Abstract Syntax Tree) nodes. It wraps [recast](https://github.com/benjamn/recast) builders with ergonomic patterns for code generation.

## Why Conjure?

When writing plugins for pg-sourcerer, you need to generate TypeScript code programmatically. While you could use string templates or direct AST builders, Conjure provides:

- **Type-safe** - Full TypeScript types for all builders
- **Fluent** - Chainable, readable API
- **Immutable** - No mutation, easier to reason about
- **Symbol tracking** - Automatic import resolution for generated exports

## Quick Example

```typescript
import { conjure } from "@danielfgray/pg-sourcerer";

// Build: z.string().uuid().nullable()
const schema = conjure.id("z")
  .method("string")
  .method("uuid")
  .method("nullable")
  .build();

// Build: { path: "/users", method: "GET" }
const config = conjure.obj()
  .prop("path", conjure.str("/users"))
  .prop("method", conjure.str("GET"))
  .build();

// Convert AST to code string
const code = conjure.print(schema);
// "z.string().uuid().nullable()"
```

## Core Concepts

### Expressions vs Statements

- **Expressions** produce values: `conjure.str("hello")`, `conjure.id("x")`
- **Statements** perform actions: `conjure.stmt.const(...)`, `conjure.stmt.return(...)`

### Builders

Conjure provides builder objects that accumulate configuration:

- **ChainBuilder** - Method chains and property access
- **ObjBuilder** - Object literals
- **ArrBuilder** - Array literals  
- **FnBuilder** - Functions and arrow functions

All builders are **immutable** - each method returns a new builder.

## Next Steps

- [Expressions](./expressions) - Build values and chains
- [Statements](./statements) - Build declarations and control flow
- [TypeScript Types](./typescript-types) - Type annotations and interfaces
- [Functions](./functions) - Build function expressions
- [Imports & Exports](./imports-exports) - Export declarations with symbol tracking
