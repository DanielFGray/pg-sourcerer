# PostgreSQL to Zod Direct Mapping Fix

## Problem Statement

The current pg-sourcerer implementation has a fundamental architectural flaw in how PostgreSQL types are mapped to Zod schemas. Instead of directly mapping PostgreSQL types to appropriate Zod methods, it uses an unnecessary intermediate step through TypeScript types.

**Current Problematic Flow:**
```
PostgreSQL Type → TypeScript Type → Zod Method
pg_catalog.uuid → "string" → z.string() ❌
pg_catalog.date → "Date" → z.Date() ❌ (invalid Zod method)
```

**Desired Direct Flow:**
```
PostgreSQL Type → Zod Method
pg_catalog.uuid → z.uuid() ✅
pg_catalog.date → z.iso.date() ✅
```

## Root Cause Analysis

### Current Implementation (index.mjs:820-825)
```javascript
const tsType = utils.getTSTypeNameFromPgType(c.type, config);  // Returns "Date"
const value = b.callExpression(
  b.memberExpression(b.identifier("z"), b.identifier(tsType)), // Creates z.Date()
  []
);
```

### Problems with Current Approach

1. **Invalid Zod Methods**: `getTSTypeNameFromPgType()` returns TypeScript type names like `"Date"`, but Zod methods are lowercase like `z.date()`
2. **Lost Type Specificity**: PostgreSQL's rich type system (UUID, IP addresses, JSON) gets flattened to generic TypeScript primitives
3. **Poor Validation**: Using `z.string()` for UUIDs instead of `z.uuid()` provides no validation benefits
4. **Maintenance Overhead**: Two separate type mapping systems to maintain

## Proposed Solution: Direct PostgreSQL → Zod Mapping

### Core Implementation

Replace the current two-step process with a single direct mapping function:

```javascript
/**
 * Maps PostgreSQL types directly to Zod method names
 * @param {string} pgTypeString - PostgreSQL type identifier (e.g., "pg_catalog.uuid")
 * @param {object} config - Configuration object
 * @returns {string} - Zod method identifier for buildZodExpression()
 */
function getZodMethodFromPgType(pgTypeString, config) {
  switch (pgTypeString) {
    // Numeric types with proper integer handling
    case "pg_catalog.int2":
    case "pg_catalog.int4":
      return "int32"; // z.int32() for 32-bit integers
    case "pg_catalog.int8":
      return "bigint"; // z.bigint() for 64-bit integers
    case "pg_catalog.float4":
    case "pg_catalog.float8":
      return "number";
    case "pg_catalog.numeric":
      return "number";

    // Specialized string types with validation
    case "pg_catalog.uuid":
      return "uuid"; // z.uuid() with proper UUID validation
    case "pg_catalog.inet":
      return "ip"; // z.ipv4().or(z.ipv6()) for IP addresses
    case "pg_catalog.char":
    case "pg_catalog.bpchar":
    case "pg_catalog.varchar":
    case "pg_catalog.text":
      return "string";

    // Boolean
    case "pg_catalog.bool":
      return "boolean";

    // Date/Time with ISO format validation
    case "pg_catalog.date":
      return "iso.date"; // z.iso.date() for YYYY-MM-DD
    case "pg_catalog.time":
      return "iso.time"; // z.iso.time() for HH:MM:SS
    case "pg_catalog.timetz":
      return "iso.time";
    case "pg_catalog.timestamp":
    case "pg_catalog.timestamptz":
      return "iso.datetime"; // z.iso.datetime() for full timestamps

    // JSON with proper validation
    case "pg_catalog.json":
    case "pg_catalog.jsonb":
      return "json"; // z.json() for JSON validation

    // Array types
    case "pg_catalog._text":
      return "array.string"; // z.array(z.string())
    case "pg_catalog._int4":
      return "array.int32"; // z.array(z.int32())
    case "pg_catalog._uuid":
      return "array.uuid"; // z.array(z.uuid())

    // Range types (as strings for now)
    case "pg_catalog.int4range":
    case "pg_catalog.int8range":
    case "pg_catalog.numrange":
    case "pg_catalog.tsrange":
    case "pg_catalog.tstzrange":
    case "pg_catalog.daterange":
      return "string";

    default:
      // Allow custom type mapping via configuration
      return config.zodTypeMap?.[pgTypeString] || "unknown";
  }
}
```

### Expression Builder

The mapping function works with a companion expression builder that handles complex Zod expressions:

```javascript
/**
 * Builds Zod expressions from method identifiers
 * @param {string} zodMethod - Method identifier from getZodMethodFromPgType
 * @param {object} b - Recast builders object
 * @returns {object} - AST node for Zod expression
 */
function buildZodExpression(zodMethod, b) {
  // Handle nested methods like z.iso.date()
  if (zodMethod.includes('.')) {
    const parts = zodMethod.split('.');
    let expr = b.identifier("z");
    parts.forEach(part => {
      expr = b.memberExpression(expr, b.identifier(part));
    });
    return b.callExpression(expr, []);
  }
  
  // Handle array types like z.array(z.string())
  if (zodMethod.startsWith('array.')) {
    const elementType = zodMethod.replace('array.', '');
    return b.callExpression(
      b.memberExpression(b.identifier("z"), b.identifier("array")),
      [buildZodExpression(elementType, b)]
    );
  }
  
  // Handle union types like z.ipv4().or(z.ipv6())
  if (zodMethod === 'ip') {
    return b.callExpression(
      b.memberExpression(
        b.callExpression(
          b.memberExpression(b.identifier("z"), b.identifier("ipv4")),
          []
        ),
        b.identifier("or")
      ),
      [b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("ipv6")),
        []
      )]
    );
  }
  
  // Standard single method calls like z.string()
  return b.callExpression(
    b.memberExpression(b.identifier("z"), b.identifier(zodMethod)),
    []
  );
}
```

## Implementation Plan

### Phase 1: Core Function Implementation
1. Add `getZodMethodFromPgType()` function to the utils section
2. Add `buildZodExpression()` helper function
3. Replace line 820-825 in `makeZodSchemasPlugin` to use new functions

### Phase 2: Update Generation Logic
Replace the current implementation:
```javascript
// Current (lines 820-825)
const tsType = utils.getTSTypeNameFromPgType(c.type, config);
const value = b.callExpression(
  b.memberExpression(b.identifier("z"), b.identifier(tsType)),
  []
);
```

With the new approach:
```javascript
// New implementation
const zodMethod = getZodMethodFromPgType(c.type, config);
const value = buildZodExpression(zodMethod, b);
```

### Phase 3: Configuration Enhancement
Add `zodTypeMap` option to configuration for custom type mappings:
```javascript
// pgsourcerer.config.mjs
export default {
  // ... existing config
  zodTypeMap: {
    "custom.email_type": "email",
    "custom.phone_type": "string", // Could be enhanced with regex
    "custom.json_schema": "json"
  }
}
```

## Benefits of This Approach

### 1. Better Validation
- **UUIDs**: `z.uuid()` validates UUID format instead of accepting any string
- **Dates**: `z.iso.date()` validates YYYY-MM-DD format
- **IP Addresses**: `z.ipv4().or(z.ipv6())` validates proper IP format
- **JSON**: `z.json()` validates JSON-encodable values

### 2. Improved Type Safety
- Integer types use `z.int32()` and `z.bigint()` for proper bounds checking
- Date types use ISO formats for consistent parsing
- Array types maintain element validation

### 3. Simplified Architecture
- Eliminates the TypeScript type mapping layer
- Single source of truth for PostgreSQL → Zod mappings
- Easier to maintain and extend

### 4. Extensibility
- Custom type mappings via configuration
- Easy to add support for new PostgreSQL types
- Modular expression building for complex types

## Testing Strategy

### Unit Tests
```javascript
describe('getZodMethodFromPgType', () => {
  test('maps UUID to uuid method', () => {
    expect(getZodMethodFromPgType('pg_catalog.uuid', {})).toBe('uuid');
  });
  
  test('maps date to iso.date method', () => {
    expect(getZodMethodFromPgType('pg_catalog.date', {})).toBe('iso.date');
  });
  
  test('handles custom type mappings', () => {
    const config = { zodTypeMap: { 'custom.email': 'email' } };
    expect(getZodMethodFromPgType('custom.email', config)).toBe('email');
  });
});

describe('buildZodExpression', () => {
  test('builds nested method calls', () => {
    const expr = buildZodExpression('iso.date', mockBuilders);
    // Verify AST structure for z.iso.date()
  });
  
  test('builds array expressions', () => {
    const expr = buildZodExpression('array.uuid', mockBuilders);
    // Verify AST structure for z.array(z.uuid())
  });
});
```

### Integration Tests
- Generate schemas for all PostgreSQL types and verify Zod compilation
- Test that generated schemas properly validate expected data
- Verify that invalid data is properly rejected

## Migration Impact

### Backward Compatibility
This change is **breaking** for users who rely on the current TypeScript type mappings. However, it provides significantly better validation and is worth the breaking change.

### Migration Path
1. Update generated schemas to use new Zod methods
2. Regenerate all schemas with new implementation
3. Update any custom code that depends on specific Zod method names

## Related Issues

This fix addresses multiple categories of errors identified in the type-errors analysis:
- **Zod Type Mapping Issues (6 errors)**: Completely resolved by direct mapping
- **Better Validation**: Provides runtime validation that was previously missing
- **Future-Proofing**: Easier to add new PostgreSQL type support

## Conclusion

The direct PostgreSQL → Zod mapping approach eliminates the architectural flaw of the intermediate TypeScript type conversion, provides better validation, and creates a more maintainable codebase. While it represents a breaking change, the benefits significantly outweigh the migration costs.