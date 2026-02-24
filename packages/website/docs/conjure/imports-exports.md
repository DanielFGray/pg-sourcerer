---
sidebar_position: 6
---

# Imports & Exports

Generate import and export statements for your modules.

## Imports

### Named Imports

```typescript
conjure.import.named("zod", "z")
// import { z } from "zod";

conjure.import.named("effect", "Effect", "Schema", "Layer")
// import { Effect, Schema, Layer } from "effect";
```

### Renamed Imports

```typescript
conjure.import.named(
  "react",
  { imported: "useState", local: "useMyState" }
)
// import { useState as useMyState } from "react";
```

### Default Import

```typescript
conjure.import.default("react", "React")
// import React from "react";
```

### Namespace Import

```typescript
conjure.import.namespace("valibot", "v")
// import * as v from "valibot";
```

### Side-Effect Import

```typescript
conjure.import.sideEffect("./polyfills.js")
// import "./polyfills.js";
```

## Exports (Basic)

These produce plain export statements **without** symbol tracking.

### Export Const

```typescript
conjure.export.const(
  "API_KEY",
  conjure.str("abc123"),
  conjure.ts.string()
)
// export const API_KEY: string = "abc123";
```

### Export Function

```typescript
const fn = conjure.fn()
  .param("x")
  .body(conjure.stmt.return(conjure.id("x")))
  .toDeclaration("identity");

conjure.export.fn(fn)
// export function identity(x) { return x; }
```

### Export Default

```typescript
conjure.export.default(
  conjure.obj()
    .prop("name", conjure.str("MyApp"))
    .build()
)
// export default { name: "MyApp" };
```

### Export Named Bindings

```typescript
conjure.export.named("User", "Post", "Comment")
// export { User, Post, Comment };

// With renaming
conjure.export.named(
  "User",
  { local: "AdminUser", exported: "Admin" }
)
// export { User, AdminUser as Admin };
```

### Export Type Alias

```typescript
conjure.export.type(
  "UserId",
  conjure.ts.string()
)
// export type UserId = string;
```

### Export Interface

```typescript
conjure.export.interface(
  "Config",
  [
    { name: "host", type: conjure.ts.string() },
    { name: "port", type: conjure.ts.number() }
  ]
)
// export interface Config {
//   host: string;
//   port: number;
// }
```

## Complete Example

```typescript
import { conjure } from "@danielfgray/pg-sourcerer";

// Create a program with imports and exports
const program = conjure.program(
  conjure.import.named("zod", "z"),
  conjure.export.const(
    "UserSchema",
    conjure.id("z").method("object").call([
      conjure.obj()
        .prop("id", conjure.call("z", "string"))
        .prop("email", conjure.call("z", "string"))
        .build()
    ]).build()
  ),
  conjure.export.type(
    "User",
    conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof("UserSchema")])
  )
);

// Pretty-print the code
console.log(conjure.print(program));
// import { z } from "zod";
// export const UserSchema = z.object({ id: z.string(), email: z.string() });
// export type User = z.infer<typeof UserSchema>;
```
