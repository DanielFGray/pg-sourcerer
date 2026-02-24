---
sidebar_position: 7
---

# Building Plugins

Learn how to use Conjure to build pg-sourcerer plugins.

## Plugin Structure

```typescript
import { definePlugin, conjure } from "@danielfgray/pg-sourcerer";
import { Schema as S } from "effect";

export const myPlugin = definePlugin({
  name: "my-plugin",
  provides: ["my-capability"],
  requires: [],  // Dependencies on other plugins
  
  configSchema: S.Struct({
    outputDir: S.String,
    // ... other config options
  }),
  
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entity, kind) => `${entity}${kind}`,
  },
  
  run: (ctx, config) => {
    // Generate code here
  }
});
```

## Accessing the IR

The plugin context provides the semantic IR:

```typescript
run: (ctx, config) => {
  // Iterate entities (tables)
  ctx.ir.entities.forEach((entity, name) => {
    const { shapes, relations } = entity;
    
    // Access shapes: row, insert, update, patch
    const rowFields = shapes.row.fields;
    
    // Generate code for this entity
  });
  
  // Access enums
  ctx.ir.enums.forEach((enumDef, name) => {
    const values = enumDef.values;
  });
}
```

## Building a Simple Plugin

Let's build a plugin that generates TypeScript interfaces:

```typescript
import { definePlugin, conjure, symbol } from "@danielfgray/pg-sourcerer";
import { Schema as S } from "effect";

export const simpleTypesPlugin = definePlugin({
  name: "simple-types",
  provides: ["types:simple"],
  
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entity, kind) => 
      kind === "row" ? entity : `${entity}${kind}`,
  },
  
  run: (ctx, config) => {
    const symbols = [];
    
    ctx.ir.entities.forEach((entity, entityName) => {
      // Build interface properties from row shape
      const props = entity.shapes.row.fields.map(field => ({
        name: field.name,
        type: fieldToTSType(field),
        optional: field.optional,
        readonly: field.immutable,
      }));
      
      // Create exported interface
      const interfaceNode = conjure.export.interface(entityName, props);
      
      // Register symbol for tracking
      symbols.push(symbol({
        name: entityName,
        capability: `types:simple:${entityName}`,
        node: interfaceNode,
        exports: "named",
      }));
    });
    
    return symbols;
  }
});

function fieldToTSType(field) {
  let baseType = conjure.ts.fromString(field.tsType);
  
  if (field.array) {
    baseType = conjure.ts.array(baseType);
  }
  
  if (field.nullable) {
    baseType = conjure.ts.nullable(baseType);
  }
  
  return baseType;
}
```

## Building Schema Validators

A Zod schema plugin:

```typescript
import { symbol } from "@danielfgray/pg-sourcerer/runtime";

export const zodPlugin = definePlugin({
  name: "zod-schemas",
  provides: ["schemas:zod"],
  
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  
  run: (ctx, config) => {
    const symbols = [];
    
    ctx.ir.entities.forEach((entity, entityName) => {
      // Build schema expression: z.object({ ... })
      const schemaFields = entity.shapes.row.fields.reduce(
        (obj, field) => 
          obj.prop(field.name, fieldToZodSchema(field)),
        conjure.obj()
      );
      
      const schemaExpr = conjure.id("z")
        .method("object")
        .call([schemaFields.build()])
        .build();
      
      // Export schema constant
      const schemaNode = conjure.export.const(`${entityName}Schema`, schemaExpr);
      
      symbols.push(symbol({
        name: `${entityName}Schema`,
        capability: `schemas:zod:${entityName}:row`,
        node: schemaNode,
        exports: "named",
        externalImports: [{ from: "zod", names: ["z"] }],
      }));
      
      // Export inferred type
      const typeNode = conjure.export.type(
        entityName,
        conjure.ts.qualifiedRef(
          "z",
          "infer",
          [conjure.ts.typeof(`${entityName}Schema`)]
        )
      );
      
      symbols.push(symbol({
        name: entityName,
        capability: `types:zod:${entityName}:row`,
        node: typeNode,
        exports: "named",
      }));
    });
    
    return symbols;
  }
});

function fieldToZodSchema(field) {
  let chain = conjure.id("z");
  
  // Base type
  switch (field.tsType) {
    case "string":
      chain = chain.method("string");
      break;
    case "number":
      chain = chain.method("number");
      break;
    case "boolean":
      chain = chain.method("boolean");
      break;
    default:
      chain = chain.method("unknown");
  }
  
  // Apply modifiers
  if (field.array) {
    chain = chain.method("array");
  }
  
  if (field.nullable) {
    chain = chain.method("nullable");
  }
  
  if (field.optional) {
    chain = chain.method("optional");
  }
  
  return chain.build();
}
```

## Generating Query Functions

Build type-safe query functions with Kysely:

```typescript
export const queryPlugin = definePlugin({
  name: "kysely-queries",
  provides: ["queries:kysely"],
  requires: ["types:kysely"],  // Depends on Kysely types
  
  run: (ctx, config) => {
    const symbols = [];
    
    ctx.ir.entities.forEach((entity, entityName) => {
      const tableName = entity.pgName;
      const pkField = entity.shapes.row.fields.find(f => f.isPrimaryKey);
      
      if (!pkField) return;
      
      // Build findById query function
      const fnNode = conjure.export.const(
        "findById",
        conjure.fn()
          .arrow()
          .rawParam(
            conjure.param.destructured([
              { name: pkField.name, type: conjure.ts.fromString(pkField.tsType) }
            ])
          )
          .body(
            conjure.stmt.return(
              conjure.id("db")
                .method("selectFrom", [conjure.str(tableName)])
                .method("selectAll")
                .method("where", [
                  conjure.str(pkField.name),
                  conjure.str("="),
                  conjure.id(pkField.name)
                ])
                .method("executeTakeFirst")
                .build()
            )
          )
          .build()
      );
      
      symbols.push(symbol({
        name: "findById",
        capability: `queries:kysely:${entityName}:findById`,
        node: fnNode,
        exports: "named",
      }));
    });
    
    return symbols;
  }
});
```

## Tips & Best Practices

### 1. Return Symbols from Plugins

Plugins should return an array of `RenderedSymbol` objects created with the `symbol()` factory:

```typescript
// ✅ Good - returns symbols for tracking
run: (ctx, config) => {
  const symbols = [];
  // ... build nodes
  symbols.push(symbol({
    name: "UserSchema",
    capability: "schemas:zod:User:row",
    node: schemaNode,
    exports: "named",
  }));
  return symbols;
}
```

### 2. Build AST, Don't Template Strings

```typescript
// ✅ Good - type-safe AST
conjure.id("z").method("string").method("uuid").build()

// ❌ Bad - string concatenation
"z.string().uuid()"
```

### 3. Check Field Properties

Fields have many useful properties:

```typescript
field.name          // Column name
field.tsType        // TypeScript type string
field.nullable      // Can be null
field.optional      // Can be omitted
field.immutable     // Should be readonly
field.isPrimaryKey  // Is primary key
field.hasDefault    // Has database default
field.array         // Is array type
```

### 4. Handle Edge Cases

```typescript
// Check for nullable/optional before building type
let type = conjure.ts.fromString(field.tsType);

if (field.array) {
  type = conjure.ts.array(type);
}

if (field.nullable) {
  type = conjure.ts.nullable(type);
}
```

### 5. Use Inflection Helpers

The context provides inflection utilities:

```typescript
ctx.inflection.camelCase("user_role")   // "userRole"
ctx.inflection.pascalCase("user")       // "User"
ctx.inflection.pluralize("user")        // "users"
ctx.inflection.singularize("users")     // "user"
```
