---
sidebar_position: 7
---

# Conjure Symbol API

Symbols are the fundamental unit of output in pg-sourcerer's plugin system. When plugins generate code, they don't output strings or files directly—they output **symbols**. The runtime then resolves cross-file references and writes files automatically.

## Why Symbols?

Plugins generate code that references other plugins' output. Without symbols:

```typescript
// Plugin A generates: export const UserSchema = z.object(...)
// Plugin B needs to: import { UserSchema } from './schemas'

// Plugin B must know:
// - What file UserSchema is in (config-dependent)
// - Whether UserSchema even exists
// - What to import if UserSchema isn't available
```

With symbols:

```typescript
// Plugin A declares symbol: "schema:zod:User"
// Plugin B references symbol: "schema:zod:User"

// Runtime handles:
// - Import generation (automatically)
// - Validation (symbol exists?)
// - File placement (config-driven)
```

## RenderedSymbol Interface

The `RenderedSymbol` interface represents a complete symbol definition returned by plugins during the render phase:

```typescript
interface RenderedSymbol {
  /** The capability this symbol provides (e.g., "schema:zod:User") */
  readonly capability: string;

  /** The symbol's name (e.g., "User") */
  readonly name: string;

  /** The AST node for this symbol, or null for virtual symbols */
  readonly node: n.Node | null;

  /** How this symbol is exported from its file */
  readonly exports: "named" | "default" | false;

  /** External package imports required by this symbol */
  readonly imports?: ExternalImport[];

  /** Plugin-specific metadata (e.g., QueryMethod for queries) */
  readonly metadata?: unknown;

  /** Identifier references extracted from AST for cross-file tracking */
  readonly refs?: readonly string[];
}
```

### Fields Explained

| Field | Type | Description |
|-------|------|-------------|
| `capability` | `string` | Unique identifier combining the plugin's capability with the symbol name. Used for cross-plugin references. |
| `name` | `string` | The exported name of the symbol. Combined with `capability` for unique identity. |
| `node` | `n.Node \| null` | The AST node for the symbol. Null for virtual symbols that only provide metadata. |
| `exports` | `"named" \| "default" \| false` | How the symbol should be exported from its file. `false` means internal-only. |
| `imports` | `ExternalImport[]` | External package imports needed by this symbol's code. |
| `metadata` | `unknown` | Plugin-specific data (e.g., `QueryMethod` metadata for query symbols). |
| `refs` | `readonly string[]` | Extracted identifier names for automatic cross-file import tracking. |

## ExternalImport

The `ExternalImport` interface declares external package dependencies:

```typescript
interface ExternalImport {
  /** Package/module path to import from */
  readonly from: string;

  /** Named imports: `{ a, b, c }` */
  readonly names?: readonly string[];

  /** Type-only named imports: `{ type A, type B }` */
  readonly types?: readonly string[];

  /** Default import name: `default: "React"` → `import React from "react"` */
  readonly default?: string;

  /** Namespace import: `namespace: "v"` → `import * as v from "valibot"` */
  readonly namespace?: string;
}
```

### Usage Examples

```typescript
// Named imports
{
  from: "zod",
  names: ["z", "ZodError"]
}
// import { z, ZodError } from "zod";

// Type-only imports
{
  from: "effect",
  types: ["Schema", "Layer"]
}
// import type { Schema, Layer } from "effect";

// Default import
{
  from: "react",
  default: "React"
}
// import React from "react";

// Namespace import
{
  from: "valibot",
  namespace: "v"
}
// import * as v from "valibot";

// Combined (names + default)
{
  from: "lodash",
  names: ["uniq", "map"],
  default: "_"
}
// import _, { uniq, map } from "lodash";
```

## Cross-File References

The `refs` field enables automatic import generation across files. When a symbol references identifiers that exist in other symbols, the runtime generates the necessary imports automatically.

### How It Works

1. Plugin generates AST node with identifier references
2. `extractIdentifierRefs(node)` extracts all identifier names
3. Runtime maps names to declared symbols across all plugins
4. When emitting files, runtime generates `import { X } from "./other-file"` for each referenced symbol

### Example Flow

```typescript
// Plugin A (schema plugin) renders:
const schemaSymbol: RenderedSymbol = {
  name: "User",
  capability: "schema:zod:User",
  node: conjure.export.const(
    "User",
    conjure.id("z").method("object").call([...]).build()
  ),
  exports: "named",
  refs: ["z"]  // References "z" from zod package
}

// Plugin B (query plugin) renders:
const querySymbol: RenderedSymbol = {
  name: "findUserById",
  capability: "queries:findUserById",
  node: conjure.export.fn(
    conjure.fn()
      .param("id", conjure.ts.string())
      .body([
        conjure.stmt.const("user", conjure.id("db").method("queryOne").call([...]))
      ])
      .toDeclaration("findUserById")
  ),
  exports: "named",
  refs: ["User"]  // References User schema from Plugin A
}

// Runtime emits:
// File: schemas/zod.ts
//   import { z } from "zod";
//   export const User = z.object(...);
//
// File: queries/users.ts
//   import { User } from "../schemas/zod";
//   export function findUserById(id: string) { ... }
```

## extractIdentifierRefs

Utility function for extracting identifier references from AST nodes:

```typescript
/**
 * Extract all identifier and type reference names from an AST node.
 * Used for automatic cross-file import tracking.
 *
 * Scans for:
 * - Identifier nodes (variable/function refs)
 * - TSTypeQuery nodes (typeof X)
 *
 * Returns deduplicated array of identifier names.
 */
function extractIdentifierRefs(node: n.Node): string[]
```

### Usage

```typescript
import { conjure, extractIdentifierRefs } from "@danielfgray/pg-sourcerer";

// Build an AST node
const node = conjure.id("z")
  .method("object")
  .call([
    conjure.obj()
      .prop("id", conjure.call("z", "string"))
      .prop("name", conjure.call("z", "string"))
      .build()
  ])
  .build();

// Extract identifier references
const refs = extractIdentifierRefs(node);
// refs = ["z", "object", "string", "id", "name"]

// When used in RenderedSymbol:
const symbol: RenderedSymbol = {
  name: "User",
  capability: "schema:zod:User",
  node,
  exports: "named",
  refs: extractIdentifierRefs(node)  // Automatic tracking
};
```

### What Gets Extracted

The function recursively traverses the AST and extracts:

1. **Identifier nodes** - All identifier names in expressions
2. **TSTypeQuery nodes** - `typeof X` extracts `"X"`

## Complete Plugin Example

Here's a complete example of a Zod schema plugin that returns `RenderedSymbol[]`:

```typescript
import { Effect } from "effect";
import type { Plugin } from "@danielfgray/pg-sourcerer";
import { IR, Conjure } from "@danielfgray/pg-sourcerer/services";
import { conjure, extractIdentifierRefs } from "@danielfgray/pg-sourcerer/conjure";
import { isTableEntity, isEnumEntity } from "@danielfgray/pg-sourcerer/ir";

export const zodPlugin: Plugin = {
  name: "zod",
  provides: ["schema"],

  render: Effect.gen(function* () {
    const ir = yield* IR;
    const { exp, id, obj, arr, ts } = yield* Conjure;

    const symbols: RenderedSymbol[] = [];

    // Generate enum schemas
    for (const entity of ir.entities.values()) {
      if (!isEnumEntity(entity)) continue;

      const schemaNode = conjure.id("z")
        .method("enum", [
          arr(...entity.values.map(v => conjure.str(v))).build()
        ])
        .build();

      symbols.push({
        name: entity.name,
        capability: `schema:zod:${entity.name}`,
        node: conjure.export.const(entity.name, schemaNode),
        exports: "named",
        imports: [{ from: "zod", names: ["z"] }],
        refs: extractIdentifierRefs(schemaNode),
        metadata: {
          entity: entity.name,
          kind: "enum"
        }
      });
    }

    // Generate table schemas
    for (const entity of ir.entities.values()) {
      if (!isTableEntity(entity)) continue;

      // Build field map
      const fieldMap = conjure.obj().fromEntries(
        entity.shapes.row.fields.map(f => [
          f.name,
          fieldToZodType(f, id, obj, ts)
        ])
      ).build();

      const schemaNode = conjure.id("z")
        .method("object", [fieldMap])
        .build();

      // Row shape schema
      symbols.push({
        name: entity.name,
        capability: `schema:zod:${entity.name}`,
        node: conjure.export.const(entity.name, schemaNode),
        exports: "named",
        imports: [{ from: "zod", names: ["z"] }],
        refs: extractIdentifierRefs(schemaNode),
        metadata: {
          entity: entity.name,
          kind: "table",
          shape: "row"
        }
      });

      // Insert shape schema (nullable optional fields)
      const insertFieldMap = conjure.obj().fromEntries(
        entity.shapes.row.fields.map(f => [
          f.name,
          f.hasDefault
            ? conjure.call("z", f.nullable ? "optional" : "default").call([fieldToZodType(f, id, obj, ts)])
            : fieldToZodType(f, id, obj, ts)
        ])
      ).build();

      const insertSchemaNode = conjure.id("z")
        .method("object", [insertFieldMap])
        .build();

      symbols.push({
        name: `${entity.name}Insert`,
        capability: `schema:zod:${entity.name}:insert`,
        node: conjure.export.const(`${entity.name}Insert`, insertSchemaNode),
        exports: "named",
        imports: [{ from: "zod", names: ["z"] }],
        refs: extractIdentifierRefs(insertSchemaNode),
        metadata: {
          entity: entity.name,
          kind: "table",
          shape: "insert"
        }
      });

      // Inferred type export
      const typeNode = conjure.export.type(
        `${entity.name}Type`,
        ts.qualifiedRef("z", "infer", [ts.typeof(entity.name)])
      );

      symbols.push({
        name: `${entity.name}Type`,
        capability: `type:${entity.name}`,
        node: typeNode,
        exports: "named",
        refs: ["z", "infer", entity.name],
        metadata: {
          entity: entity.name,
          kind: "type"
        }
      });
    }

    return symbols;
  })
};

// Helper function to convert field to Zod type
function fieldToZodType(
  field: Field,
  id: ReturnType<typeof conjure.id>,
  obj: ReturnType<typeof conjure.obj>,
  ts: typeof conjure.ts
) {
  const baseType = tsFromString(field.type);

  if (field.nullable) {
    return id("z").method("nullable").call([baseType]).build();
  }

  if (field.isArray) {
    return id("z").method("array").call([baseType]).build();
  }

  return baseType;
}

// Helper for string → Zod type conversion
function tsFromString(type: string) {
  const zodMethods: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    date: "date",
    uuid: "uuid"
  };

  const method = zodMethods[type] || "unknown";
  return conjure.call("z", method);
}
```

## Best Practices

### 1. Always Extract Refs

Use `extractIdentifierRefs()` to populate the `refs` field:

```typescript
// ✅ Good - automatic tracking
const node = conjure.export.const("User", schemaExpr);
const symbol: RenderedSymbol = {
  name: "User",
  node,
  exports: "named",
  refs: extractIdentifierRefs(schemaNode)
};

// ❌ Bad - manual tracking, error-prone
const symbol: RenderedSymbol = {
  name: "User",
  node,
  exports: "named",
  refs: ["z", "object", "string"]  // Misses if schema changes!
};
```

### 2. Declare All External Imports

List every external package your symbol references:

```typescript
const symbol: RenderedSymbol = {
  name: "User",
  node,
  exports: "named",
  imports: [
    { from: "zod", names: ["z", "ZodError"] },
    { from: "effect", types: ["Schema"] },
    { from: "lodash", default: "_" }
  ],
  refs: extractIdentifierRefs(node)
};
```

### 3. Use Descriptive Capabilities

Include both the plugin name and entity name in capability strings:

```typescript
// ✅ Good - descriptive, prevents collisions
{
  capability: "schema:zod:User"
}

// ❌ Bad - ambiguous, may collide
{
  capability: "schema"
}
```

### 4. Populate Metadata for Cross-Plugin Communication

Use `metadata` to pass information to consuming plugins:

```typescript
// Schema plugin
{
  name: "User",
  capability: "schema:zod:User",
  metadata: {
    entity: "User",
    kind: "table",
    fields: ["id", "email", "name"]
  }
}

// Query plugin can read metadata to generate queries
const userSchema = use("schema:zod:User");
const fields = userSchema.metadata.fields;  // ["id", "email", "name"]
```

### 5. Use Virtual Symbols for Metadata-Only Exports

Set `node: null` for symbols that only provide metadata:

```typescript
{
  name: "QueryMethods",
  capability: "queries",
  node: null,  // No actual code, just metadata
  exports: false,  // Don't export anything
  metadata: {
    methods: [...queryMethods]
  }
}
```

## See Also

- [Plugin Guide](./plugin-guide) - Complete plugin authoring guide
- [Imports & Exports](./imports-exports) - Generate import/export statements
- [Introduction](./intro) - Conjure overview and concepts
