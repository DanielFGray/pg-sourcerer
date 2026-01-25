# Plugin Development

This directory contains pg-sourcerer's built-in plugins and shared utilities for plugin authors.

## Shared Helpers

The `shared/` directory contains utilities that eliminate duplication across plugins:

### pg-types.ts

PostgreSQL type classification and resolution:

```typescript
import {
  pgStringTypes,    // Set of PG string type names
  pgNumberTypes,    // Set of PG numeric type names
  pgBooleanTypes,   // Set of PG boolean type names
  pgDateTypes,      // Set of PG date/time type names
  pgJsonTypes,      // Set of PG JSON type names
  resolveFieldTypeInfo,  // Resolves Field to base type info (handles arrays, domains)
  pgTypeToTsType,   // Maps PG type to TypeScript type string
} from "./shared/pg-types.js";
```

Example - checking if a field is a string type:

```typescript
const info = resolveFieldTypeInfo(field);
if (info && pgStringTypes.has(info.typeName.toLowerCase())) {
  // Handle string field
}
```

### schema-declarations.ts

Helpers for declaring schema capabilities:

```typescript
import {
  buildShapeDeclarations,     // Declares Row/Insert/Update schemas for a table
  buildEnumDeclarations,      // Declares schema for an enum
  buildSchemaBuilderDeclaration,  // Declares a schema builder capability
} from "./shared/schema-declarations.js";
```

Example - declaring schemas for all entities:

```typescript
for (const entity of ir.entities.values()) {
  if (isTableEntity(entity)) {
    declarations.push(...buildShapeDeclarations(entity, "schema:zod"));
  } else if (isEnumEntity(entity)) {
    declarations.push(...buildEnumDeclarations(entity, "schema:zod"));
  }
}
```

### http-helpers.ts

Helpers for HTTP route generation:

```typescript
import {
  coerceParam,        // Convert URL param string to expected type
  needsCoercion,      // Check if param needs type coercion
  getRoutePath,       // Get route path for a query method
  kindToHttpMethod,   // Map QueryMethodKind to HTTP method
  defaultHttpMethodMap,  // Default mapping (read->get, create->post, etc.)
  getBodySchemaName,  // Get body schema name for create/update methods
  listByRouteFromName,  // Extract list-by route from method name
  toExternalImport,   // Convert SchemaImportSpec to ExternalImport
  buildQueryInvocation,  // Build AST for calling a query function
} from "./shared/http-helpers.js";
```

Example - building routes:

```typescript
const httpMethod = kindToHttpMethod(method.kind);
const path = getRoutePath(method, {
  kebabCase: inflection.kebabCase,
  listByRoute: (m) => listByRouteFromName(m, inflection.kebabCase),
});
```

### schema-builder.ts

Utilities for working with schema builders:

```typescript
import { getSchemaBuilder } from "./shared/schema-builder.js";

// Find an active schema builder (zod, arktype, etc.)
const builder = getSchemaBuilder(registry);
if (builder) {
  const result = builder.buildObjectSchema(fields);
}
```

## Creating a New Plugin

1. **Define your plugin** with name, provides, consumes, and lifecycle methods
2. **Use shared helpers** to reduce boilerplate
3. **Register capabilities** in declare phase
4. **Generate code** in render phase using conjure AST builders

See existing plugins for patterns:
- `zod.ts` - Schema validation plugin
- `kysely.ts` - Query builder plugin  
- `http-express.ts` - HTTP route generation plugin

## Importing Shared Helpers

From within a plugin in this directory:

```typescript
import { pgStringTypes } from "./shared/pg-types.js";
```

From external code via package exports:

```typescript
import { pgStringTypes } from "pg-sourcerer/plugins";
```
