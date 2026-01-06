# TypeScript Type Errors Analysis & Fixes

## Overview

This document provides a comprehensive analysis of the 56 TypeScript errors found in the pg-sourcerer generated code and detailed solutions for each category of issues.

**Analysis Date:** September 2025  
**TypeScript Version:** 5.9.2  
**Total Errors:** 53 across 3 generated files (reduced from 56 after inline type import fix)

## Error Distribution

| File | Error Count | Primary Issues |
|------|-------------|----------------|
| `packages/example/generated/Comments.ts` | 15 errors | Module syntax, Zod types, SQL params |
| `packages/example/generated/Posts.ts` | 25 errors | Module syntax, Zod types, SQL params, pagination |
| `packages/example/generated/Users.ts` | 13 errors | Module syntax, Zod types, duplicate identifiers |

## Detailed Error Categories

### 1. Zod Type Mapping Issues (6 errors)

#### Problem Description
The code generation incorrectly maps TypeScript type names to Zod method names, specifically:
- `z.Date()` instead of `z.date()` for timestamp types
- Direct use of TypeScript type names as Zod method identifiers

#### Root Cause Analysis
- **Location:** `packages/pg-sourcerer/index.mjs:825`
- **Code:** `b.memberExpression(b.identifier("z"), b.identifier(tsType))`
- **Issue:** `getTSTypeNameFromPgType()` returns "Date" which becomes `z.Date()` instead of `z.date()`

#### Affected PostgreSQL Types
```sql
pg_catalog.date
pg_catalog.time
pg_catalog.timetz
pg_catalog.timestamp
pg_catalog.timestamptz
```

#### Solution Implementation
Create a dedicated mapping function:

```javascript
/**
 * Maps TypeScript type names to Zod method names
 * @param {string} tsTypeName - TypeScript type name from getTSTypeNameFromPgType
 * @returns {string} - Corresponding Zod method name
 */
function getZodMethodName(tsTypeName) {
  const zodTypeMap = {
    'string': 'string',
    'number': 'number', 
    'boolean': 'boolean',
    'Date': 'date',        // Key fix: Date -> date
    'unknown': 'unknown'
  };
  
  return zodTypeMap[tsTypeName] || 'unknown';
}
```

**Implementation Location:** Replace line 825 in `makeZodSchemasPlugin`:
```javascript
// Before
const value = b.callExpression(
  b.memberExpression(b.identifier("z"), b.identifier(tsType)),
  []
);

// After  
const zodMethod = getZodMethodName(tsType);
const value = b.callExpression(
  b.memberExpression(b.identifier("z"), b.identifier(zodMethod)),
  []
);
```

### 2. Module System Issues (18 errors) ✅ Partially Fixed

#### Problem Description
TypeScript's `verbatimModuleSyntax` compiler flag enforces strict module syntax rules that the generated code violates:
- ECMAScript imports/exports in CommonJS context (12 errors)
- ~~Type-only import violations (3 errors)~~ ✅ **FIXED**: Now generates correct `import { type Sql }` syntax
- Top-level export modifier issues (6 errors)

#### Root Cause Analysis
- **Location:** `packages/pg-sourcerer/index.mjs:1442-1467` (parseDependencies function)
- **Issue:** Import/export generation doesn't respect `verbatimModuleSyntax` requirements
- **TypeScript Config:** `tsconfig.json` has `"verbatimModuleSyntax": true`

#### Specific Violations

1. **ECMAScript/CommonJS Module Mismatch**
   ```typescript
   // Current issue - requires package.json "type": "module" or different tsconfig
   import { z } from "zod";  // ❌ ECMAScript import in CommonJS context
   export const userSchema = z.object({...}); // ❌ Export in CommonJS context
   ```

2. **Export Modifier Issues**
   ```typescript
   // Generated (current)
   export const userSchema = z.object({...});
   export type User = z.infer<typeof userSchema>;
   
   // Should be (for verbatimModuleSyntax compliance)
   export const userSchema = z.object({...});
   export type { User };
   ```

#### Solution Implementation

**✅ COMPLETED: Inline Type Import Fix**
The `parseDependencies` function has been updated to generate correct inline type syntax:
```typescript
// ✅ Now generates correctly:
import { type Sql } from "postgres";  // Inline type import
import { z } from "zod";              // Value import
```

**REMAINING: Project Configuration Issues**
The remaining module system errors are configuration-related, not code generation issues:

**Option 1: Update package.json**
```json
{
  "type": "module"
}
```

**Option 2: Update tsconfig.json**
```json
{
  "compilerOptions": {
    "verbatimModuleSyntax": false,  // Or adjust module settings
    "module": "CommonJS"
  }
}
```

### 3. SQL Parameter Type Issues (18 errors)

#### Problem Description
Generated SQL query functions have incorrect parameter typing, causing:
- `unknown` types not assignable to `ParameterOrFragment<never>` (5 errors)
- Invalid await operands on non-Promise types (10 errors)
- No matching function overloads for SQL calls (3 errors)

#### Root Cause Analysis
- **Location:** Query generation in `makeQueriesPlugin` (lines 1310-1394)
- **Issue 1:** Parameter types not properly typed for SQL adapter
- **Issue 2:** Return type annotations missing or incorrect
- **Issue 3:** SQL template literal typing incorrect for postgres adapter

#### Affected Query Types
```typescript
// Problematic generated code
async byUsername({ username }, sql: Sql) {
  const result = await sql<Array<User>>`select * from users where username = ${username}`;
  return result[0];
}
```

#### Solution Implementation

**Phase 1: Fix Parameter Typing**
```javascript
// In queryDataToObjectMethodsAST function
function generateParameterType(param, config) {
  if (typeof param.type === 'string' && config.inflections.types) {
    // Check if it's a model type
    const modelTypes = ['User', 'Post', 'Comment']; // Should be dynamic
    if (modelTypes.includes(param.type)) {
      return b.tsTypeReference(b.identifier(param.type));
    }
  }
  
  // Use primitive type mapping
  return utils.getASTTypeFromTypeName(param.type);
}
```

**Phase 2: Fix SQL Template Typing**
```javascript
// For postgres adapter in queryDataToObjectMethodsAST
postgres() {
  const { query, params } = queryBuilder(queryData);
  
  // Fix template literal construction
  const queryParts = query.split("?");
  const templateElements = queryParts.map((part, i) => 
    b.templateElement({ 
      raw: part, 
      cooked: part 
    }, i === queryParts.length - 1)
  );
  
  const queryExpression = b.awaitExpression(
    b.taggedTemplateExpression(
      b.identifier("sql"), // Remove type instantiation that causes issues
      b.templateLiteral(
        templateElements,
        params.map(name => b.identifier(name))
      )
    )
  );
  
  // Rest of implementation...
}
```

**Phase 3: Fix Return Type Annotations**
```javascript
// Update method signature generation
const methodSignature = b.objectMethod.from({
  kind: "method",
  async: true,
  key: b.identifier(queryData.name),
  returnType: queryData.returnType ? b.tsTypeAnnotation(
    queryData.returnsMany 
      ? b.tsArrayType(b.tsTypeReference(b.identifier(queryData.returnType)))
      : b.tsTypeReference(b.identifier(queryData.returnType))
  ) : undefined,
  // ... rest of signature
});
```

### 4. Undefined Variables Issues (8 errors)

#### Problem Description
Pagination parameters `offset` and `limit` are referenced in generated queries but not defined in function signatures.

#### Root Cause Analysis
- **Location:** `queryBuilder` function (lines 1166-1177)
- **Issue:** Query builder adds pagination params but function signatures don't include them
- **Code:**
  ```javascript
  if (queryData.returnsMany) params.push("offset", "limit");
  ```

#### Solution Implementation

**Phase 1: Fix Query Builder**
```javascript
function queryBuilder(queryData) {
  const target = `${queryData.schema}.${queryData.identifier}`;
  const params = [];
  
  const query = (() => {
    const patch = ("patch" in queryData.params && queryData.params.patch.Pick) || null;
    
    switch (queryData.operation) {
      case "select": {
        // Add explicit parameters in order
        if (queryData.where) {
          params.push(...queryData.where.map(([_, __, paramName]) => paramName || "param"));
        }
        if (queryData.order) {
          params.push(...queryData.order.filter(p => typeof p === 'string'));
        }
        if (queryData.returnsMany) {
          params.push("offset", "limit"); // These need to be in function signature
        }
        
        return [
          "select *",
          `from ${target}`,
          queryData.join,
          queryData.where && `where ${queryData.where.map(p => p.join(" ")).join(" and ")}`,
          queryData.order && `order by ${queryData.order.join(" ")}`,
          queryData.returnsMany && "offset ? limit ?"
        ].filter(Boolean).join(" ");
      }
      // ... other cases
    }
  })();
  
  return { query, params };
}
```

**Phase 2: Update Function Signature Generation**
```javascript
// In queryDataToObjectMethodsAST, update parameter generation
params: [
  b.objectPattern.from({
    properties: [
      // Existing parameters
      ...Object.entries(queryData.params).flatMap(/* existing logic */),
      
      // Add pagination parameters for queries that return many
      ...(queryData.returnsMany ? [
        b.property.from({
          kind: "init",
          key: b.identifier("offset"),
          value: b.assignmentPattern(b.identifier("offset"), b.literal(0)),
          shorthand: true
        }),
        b.property.from({
          kind: "init", 
          key: b.identifier("limit"),
          value: b.assignmentPattern(b.identifier("limit"), b.literal(50)),
          shorthand: true
        })
      ] : [])
    ],
    typeAnnotation: /* update to include offset?: number, limit?: number */
  }),
  // SQL client parameter...
]
```

### 5. Duplicate Identifier Issues (2 errors)

#### Problem Description
`ByUsername` type/function declared multiple times in `Users.ts`, causing naming conflicts.

#### Root Cause Analysis
- **Location:** Index processing in `makeQueriesPlugin`
- **Issue:** Multiple indexes on the same column generate conflicting names
- **Specific Case:** Username column has both unique constraint and search index

#### Solution Implementation

```javascript
// In makeQueriesPlugin, add name deduplication
function generateUniqueMethodName(baseName, existingNames) {
  let counter = 0;
  let uniqueName = baseName;
  
  while (existingNames.has(uniqueName)) {
    counter++;
    uniqueName = `${baseName}${counter}`;
  }
  
  existingNames.add(uniqueName);
  return uniqueName;
}

// Usage in index processing
const existingMethodNames = new Set();

const tables = Object.values(schema.tables)
  .filter(table => pluginOpts.tables?.includes(table.name) ?? true)
  .map(table => {
    return Object.values(table.indexes).flatMap(index => {
      // ... existing logic ...
      
      const baseMethodName = config.inflections.methods(`by_${columnName}`);
      const uniqueMethodName = generateUniqueMethodName(baseMethodName, existingMethodNames);
      
      return {
        name: uniqueMethodName, // Use unique name
        // ... rest of query data
      };
    });
  });
```

### 6. Import Generation & Deduplication Issues (1 error)

#### Problem Description
Import statements not properly deduplicated and merged, causing module resolution issues.

#### Root Cause Analysis
- **Location:** `parseDependencies` function (lines 1442-1467)
- **Issue:** Complex import merging logic has edge cases

#### Solution Implementation

```javascript
function parseDependencies(deps) {
  const b = recast.types.builders;
  
  // Create a more robust grouping and deduplication system
  const importMap = new Map();
  
  deps.forEach(dep => {
    const key = `${dep.path}:${dep.typeImport ? 'type' : 'value'}:${dep.default ? 'default' : 'named'}`;
    
    if (!importMap.has(key)) {
      importMap.set(key, {
        path: dep.path,
        typeImport: dep.typeImport,
        default: dep.default,
        identifiers: new Set()
      });
    }
    
    importMap.get(key).identifiers.add(dep.identifier);
  });
  
  return Array.from(importMap.values()).map(({ path, typeImport, default: isDefault, identifiers }) => {
    return b.importDeclaration.from({
      importKind: typeImport ? "type" : "value",
      specifiers: Array.from(identifiers).map(identifier =>
        isDefault 
          ? b.importDefaultSpecifier(b.identifier(identifier))
          : b.importSpecifier(b.identifier(identifier))
      ),
      source: b.literal(path)
    });
  });
}
```

## Implementation Priority & Timeline

### Phase 1: Critical Fixes (High Priority)
1. **Zod Type Mapping** - Breaks schema validation entirely
   - Estimated effort: 2-4 hours
   - Files: `index.mjs:820-830`
   
2. ✅ **~~Module System Compliance~~** - ~~Prevents compilation~~ 
   - **COMPLETED**: Type-only import violations fixed
   - **REMAINING**: Project configuration (CommonJS vs ESM) - not a code generation issue

### Phase 2: Runtime Fixes (Medium Priority)
3. **SQL Parameter Typing** - Causes runtime failures
   - Estimated effort: 6-8 hours
   - Files: `index.mjs:1310-1394`
   
4. **Pagination Variables** - Breaks query execution
   - Estimated effort: 3-4 hours
   - Files: Query builder and signature generation

### Phase 3: Quality Improvements (Low Priority)
5. **Duplicate Identifiers** - Naming conflicts
   - Estimated effort: 2-3 hours
   - Files: `makeQueriesPlugin` logic
   
6. **Import Deduplication** - Module resolution edge cases
   - Estimated effort: 2-3 hours
   - Files: `parseDependencies` function

## Testing Strategy

### Unit Tests Required
```javascript
// Test Zod mapping
describe('getZodMethodName', () => {
  test('maps Date to date', () => {
    expect(getZodMethodName('Date')).toBe('date');
  });
  
  test('maps primitives correctly', () => {
    expect(getZodMethodName('string')).toBe('string');
    expect(getZodMethodName('number')).toBe('number');
    expect(getZodMethodName('boolean')).toBe('boolean');
  });
});

// Test query builder
describe('queryBuilder', () => {
  test('includes pagination params for returnsMany queries', () => {
    const result = queryBuilder({
      operation: 'select',
      returnsMany: true,
      schema: 'public',
      identifier: 'users'
    });
    
    expect(result.params).toContain('offset');
    expect(result.params).toContain('limit');
  });
});
```

### Integration Tests Required
1. **Full Code Generation** - Generate actual files and run TypeScript compilation
2. **Database Integration** - Test generated queries against real database
3. **Module Loading** - Test generated modules can be imported correctly

## Validation Checklist

Before considering fixes complete:

- [x] ✅ **Type-only import violations resolved** - Now generates `import { type Sql }`
- [ ] All remaining TypeScript errors resolved (53 remaining)
- [ ] Generated code compiles without errors
- [ ] Generated queries execute successfully
- [ ] Module imports/exports work correctly (requires project config fix)
- [ ] No duplicate identifiers in generated code
- [ ] Zod schemas validate correctly
- [ ] Pagination works in generated queries
- [ ] SQL parameter typing is correct
- [ ] verbatimModuleSyntax compliance achieved (partially - config issue remains)

## Related Documentation

- [Refactor Plan](./refactor.md) - Broader refactoring strategy
- [TypeScript Compiler Options](https://www.typescriptlang.org/tsconfig#verbatimModuleSyntax)
- [Zod Documentation](https://zod.dev) - Schema validation
- [Recast AST Documentation](https://github.com/benjamn/recast) - AST manipulation

---

**Last Updated:** September 2025  
**Next Review:** After implementing Phase 1 fixes