# TODO Analysis and Implementation Plan

## Analysis of TODO Comments

After examining each TODO comment in context, here's a comprehensive analysis and implementation plan, sorted from easiest to most complex:

## 1. **EASY** - Add Views Support to Schemas Plugin
**File:** `packages/pg-sourcerer/plugins/schemas.mjs:91`
**Context:** The schemas plugin currently only processes tables but has a TODO to add views
**Current Code:**
```javascript
return [
  ...tables,
  // TODO: ...views
].map(({ identifier, content }) => ...)
```
**Analysis:** Views are already being introspected and processed in the introspection layer. The schemas plugin just needs to include them in the output alongside tables.
**Implementation:** Add `...views` to the array return, similar to how tables are handled.
**Complexity:** Very Low - Simple array spread operation

## 2. **EASY** - Apply Inflection to Function Arguments  
**File:** `packages/pg-sourcerer/introspection.mjs:363`
**Context:** Function argument names are not being processed through inflection rules
**Current Code:**
```javascript
const argName = proc.proargnames?.[i] ?? i + 1;
// TODO: inflection?
```
**Analysis:** The system has an inflection system but it's not being applied to function argument names. Should apply the same inflection as used for other identifiers.
**Implementation:** Apply `inflections.arguments(argName)` or similar inflection function.
**Complexity:** Low - Simple function call addition

## 3. **MEDIUM** - Extend Import Statement Parsing
**File:** `packages/pg-sourcerer/utils/index.mjs:126`
**Context:** The dependency parser doesn't handle mixed default and named imports
**Current Code:**
```javascript
// TODO: not handled: import <default>, { [type] <named> } from '<path>'
export function parseDependencies(deps) {
```
**Analysis:** The parser handles separate default and named imports but not the mixed syntax like `import React, { useState, type FC } from 'react'`. Need to extend the parsing logic to handle this case.
**Implementation:** Modify the grouping logic to handle mixed import statements, creating appropriate AST nodes for both default and named imports in a single statement.
**Complexity:** Medium - Requires AST manipulation and parsing logic changes

## 4. **MEDIUM** - Add Index Options Processing
**File:** `packages/pg-sourcerer/introspection.mjs:274`
**Context:** Index introspection ignores index-specific options like sort order, nulls handling
**Current Code:**
```javascript
// TODO: process index-specific options?
const option = index.indoption;
```
**Analysis:** PostgreSQL indexes have options stored in `indoption` array that specify sort order (ASC/DESC), nulls handling (NULLS FIRST/LAST), etc. These should be parsed and included in the index metadata.
**Implementation:** Decode the `indoption` bit array to extract sort order and nulls handling for each column in the index.
**Complexity:** Medium - Requires understanding PostgreSQL's indoption bit encoding

## 5. **MEDIUM** - Add View-Specific Attributes
**File:** `packages/pg-sourcerer/introspection.mjs:151`  
**Context:** Views might have additional metadata beyond what tables have
**Current Code:**
```javascript
// TODO: any other attributes specific to views? references? pseudo-FKs?
columns: processColumns(view._id, { introspection, role }),
constraints: processReferences(view._id, { introspection }),
```
**Analysis:** Views might have:
- Materialized view refresh settings
- View definition/query text
- Dependencies on other tables/views
- Updatable view rules
- Instead-of triggers
**Implementation:** Research PostgreSQL view metadata and add relevant attributes to the view processing.
**Complexity:** Medium-High - Requires PostgreSQL system catalog research

## 6. **MEDIUM-HIGH** - Alternative Query Export Styles
**File:** `packages/pg-sourcerer/plugins/queries.mjs:87`
**Context:** Currently exports query builders as objects, but could support other patterns
**Current Code:**
```javascript
// TODO: alternative styles? what about just exporting functions?
/**
 * @param {{
 *   queryData: Array<QueryData>;
 *   name: string;
```
**Analysis:** The plugin currently generates object-based query builders. Alternative styles could include:
- Direct function exports
- Class-based builders  
- Functional composition patterns
- Different parameter binding styles
**Implementation:** Add configuration options to control export style, modify the AST generation accordingly.
**Complexity:** Medium-High - Requires significant plugin architecture changes

## 7. **HIGH** - Interactive Configuration Generation
**File:** `packages/pg-sourcerer/index.mjs:128`
**Context:** When no config found, could prompt user to create one interactively
**Current Code:**
```javascript
if (!configSearch) {
  console.error("a pgsourcerer config is required");
  // TODO: what if we codegen a config from prompts?
  process.exit(1);
}
```
**Analysis:** Instead of erroring when no config is found, could:
- Prompt for database connection details
- Ask about schema preferences
- Guide through plugin selection
- Generate initial configuration file
**Implementation:** Create an interactive CLI wizard using libraries like `enquirer` or `prompts`, then generate a config file based on responses.
**Complexity:** High - Requires CLI interaction library, validation, and config generation logic

## 8. **HIGH** - Plugin Phase System Extension
**File:** `packages/pg-sourcerer/index.mjs:107`
**Context:** Plugin system currently only has a render phase, could support more phases
**Current Code:**
```javascript
// TODO: other possible phases?
render: z
  .function()
  .args(z.any())
  .returns(z.union([z.array(OutputSchema), z.promise(z.array(OutputSchema))])),
```
**Analysis:** Could add phases like:
- `validate` - Pre-render validation
- `transform` - Data transformation before rendering
- `post-process` - Post-render processing
- `cleanup` - Resource cleanup
- Plugin dependency resolution between phases
**Implementation:** Extend the plugin schema and execution engine to support multiple phases with dependency management.
**Complexity:** High - Requires architectural changes to plugin system and execution pipeline

## Implementation Priority

**Phase 1 (Quick Wins):**
1. Add views to schemas plugin output
2. Apply inflection to function arguments

**Phase 2 (Medium Complexity):**
3. Extend import statement parsing
4. Add index options processing
5. Research and add view-specific attributes

**Phase 3 (Complex Features):**
6. Alternative query export styles
7. Interactive configuration generation  
8. Plugin phase system extension

Each TODO represents a legitimate improvement opportunity, with the simpler ones being good candidates for immediate implementation and the complex ones requiring more architectural planning.