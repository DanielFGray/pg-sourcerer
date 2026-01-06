# pg-sourcerer Codebase Exploration Summary

## What Was Explored

This document summarizes the comprehensive exploration of the pg-sourcerer codebase, specifically focusing on:
- Service definitions and architecture
- How dependency injection (DI) is currently implemented
- Where the Effect framework's context system is used well
- Where prop-drilling or explicit parameter passing occurs
- Configuration and introspection data flow

## Key Files Analyzed

### Service Definitions (`packages/sourcerer-rewrite/src/services/`)

1. **inflection.ts** (240 lines)
   - CoreInflection service with naming transformations
   - Context.Tag pattern with live/stub layers
   - Well-integrated with PluginRunner

2. **plugin-context.ts** (123 lines)
   - Defines PluginContext interface (the main prop-drilling point)
   - Creates opaque context objects for plugins
   - 8 dependencies manually wrapped into single object

3. **plugin-runner.ts** (346 lines)
   - Orchestrates plugin execution
   - Uses modern Effect.Service pattern
   - Validates configs, checks capability conflicts, topologically sorts plugins
   - **Main issue**: Creates PluginContext objects manually for each plugin

4. **emissions.ts** (134 lines)
   - EmissionBuffer service for buffering code generation
   - Context.Tag pattern with fresh instance per run
   - Validates for conflicts

5. **symbols.ts** (238 lines)
   - SymbolRegistry for tracking emitted symbols
   - Context.Tag pattern
   - Handles import resolution

6. **type-hints.ts** (177 lines)
   - TypeHintRegistry for user-configured type overrides
   - Parametric factory function pattern
   - Good precedence-based matching

7. **file-writer.ts** (149 lines)
   - FileWriter service with @effect/platform integration
   - Context.Tag pattern
   - Handles file I/O with dry-run support

8. **ir-builder.ts** (500+ lines)
   - Transforms pg-introspection output to SemanticIR
   - **Main issue**: Pure helper functions pass `inflection` parameter through multiple layers
   - Examples: buildField, buildShape, buildEntity all take inflection

9. **config-loader.ts** (163 lines)
   - Loads pgsourcerer.config.ts/js files
   - Context.Tag pattern
   - Uses lilconfig for file discovery

10. **introspection.ts** (150 lines)
    - **Main issue**: Has service tag but no Layer created
    - Completely bypasses Effect context system
    - Directly instantiates services instead of using DI

11. **smart-tags-parser.ts** (150+ lines)
    - Parses JSON smart tags from PostgreSQL comments
    - Pure function pattern (correct - doesn't need service)
    - Wraps pure logic in Effect for error handling

### Core IR Types (`packages/sourcerer-rewrite/src/ir/`)

1. **semantic-ir.ts** (219 lines)
   - Defines SemanticIR (the core data structure)
   - Field, Shape, Entity, Relation, EnumDef types
   - Builder pattern with freezeIR()

2. **smart-tags.ts**
   - SmartTags schema and types
   - Configuration options for entities/fields

### Tests

1. **plugin-runner.test.ts** (200+ lines)
   - Uses @effect/vitest `layer()` pattern
   - Excellent example of test composition
   - Tests capability expansion, conflict detection, topological sorting

2. **ir-builder.integration.test.ts** (100+ lines)
   - Integration tests with real database
   - Manual layer composition with Effect.provide()
   - Good patterns for integration testing

3. **type-hints.test.ts**, **symbols.test.ts**
   - Pure function testing patterns
   - No service dependencies needed

## Architecture Findings

### What's Working Well ✅

1. **Service definitions** - Context.Tag pattern implemented correctly for:
   - Inflection
   - Emissions
   - Symbols
   - TypeHints
   - FileWriter
   - IRBuilder
   - PluginRunner

2. **Modern Effect patterns** - PluginRunner uses Effect.Service pattern with dependency declaration

3. **Test composition** - @effect/vitest's `layer()` wrapper makes tests clean and composable

4. **Pure functions** - Smart tags parser correctly uses pure functions wrapped in Effect for errors

5. **Layer patterns** - TypeHints shows excellent parametric factory pattern for configuration

### What Needs Improvement ⚠️

1. **PluginContext is prop-drilling** (MAIN ISSUE)
   - Creates opaque object with 8+ dependencies
   - Plugins can't directly yield services they need
   - Adding new services requires modifying all layers
   - Forces plugins to couple with fixed interface

2. **IR Builder parameter passing**
   - Functions like buildField, buildShape pass `inflection` through 4+ layers
   - Could use Reader pattern or Effect context
   - Repetitive and hard to extend

3. **Introspection service incomplete**
   - Has Context.Tag defined but NO Layer created
   - Completely bypasses Effect DI system
   - Uses direct instantiation instead of context

4. **No unified test layer bundle**
   - Each test manually creates layers
   - Could benefit from reusable test layer compositions

5. **ConfigLoader initialization**
   - Uses eager singleton creation
   - Could use Layer.sync for lazy initialization

## Dependency Flow

```
Config → ConfigLoader
         ↓
Database → Introspection (BYPASSES DI!)
           ↓
SmartTags Parser (pure function)
           ↓
IRBuilder (depends on Inflection)
           ↓
PluginRunner (depends on Inflection)
    ↓ (prop-drill to PluginContext)
    → Inflection, Symbols, Emissions, TypeHints, etc.
         ↓
Plugin.run(PluginContext, config)
```

## Data Flow

1. **Configuration** loaded via ConfigLoader service
2. **Database introspected** directly (not via Effect context)
3. **SmartTags parsed** from PostgreSQL comments
4. **SemanticIR built** by passing inflection explicitly through helper functions
5. **Plugins executed** by wrapping dependencies in PluginContext object
6. **Code emitted** to EmissionBuffer via PluginContext methods
7. **Symbols registered** for import resolution
8. **Files written** to disk via FileWriter service

## Key Insights

### 1. Service Architecture is Sound

The codebase correctly uses Effect's Context.Tag pattern for most services. Services are well-defined with clear interfaces and both live/stub implementations for testing.

### 2. PluginContext is the Pain Point

Instead of having plugins be Effects that directly yield services, there's an intermediary "PluginContext" object. This is artificial - Effect already provides this capability through the context system.

**Current**: Plugin receives opaque object
```typescript
plugin.run(pluginContext: PluginContext, config: TConfig)
```

**Better**: Plugin is an Effect that requests services
```typescript
plugin.run(config: TConfig): Effect<void, PluginExecutionFailed>
```

### 3. Parameter Passing is a Symptom

The extensive parameter passing in IR builder (buildField, buildShape, buildEntity all taking inflection) is a symptom of not having dependencies in the Effect context.

### 4. Some Services Bypass DI

Introspection service has a tag but doesn't create a Layer. This is bypassed entirely and directly instantiated, breaking the architectural pattern.

### 5. Test Patterns are Strong

The use of @effect/vitest's `layer()` wrapper is the right approach. Tests declare dependencies cleanly without manual boilerplate.

## Specific Code Examples

### PluginContext Prop-Drilling (lines 295-313 in plugin-runner.ts)
```typescript
const ctx = createPluginContext({
  ir,
  inflection,
  symbols,
  typeHints,
  emissions,
  artifacts,
  pluginName: plugin.name,
});
return plugin.run(ctx, config);
```

### IR Builder Parameter Passing (lines 279-295 in ir-builder.ts)
```typescript
const rowShape = buildShape(name, "row", attributes, attributeTags, inflection)
// ... later
insert: buildShape(name, "insert", attributes, attributeTags, inflection),
update: buildShape(name, "update", attributes, attributeTags, inflection),
patch: buildShape(name, "patch", attributes, attributeTags, inflection),
```

### Introspection Service Bypass (lines 145-148 in introspection.ts)
```typescript
export function introspectDatabase(options: IntrospectOptions) {
  return createDatabaseIntrospection().introspect(options)
}
// ^ Completely ignores DatabaseIntrospectionService tag and Layer
```

## Recommendations (Priority Order)

### High Priority
1. Convert Plugin interface to use Effect-based dependencies
2. Create DatabaseIntrospectionLive Layer and use in context
3. Move inflection into Effect context for IR builder

### Medium Priority
4. Extract reusable test layer bundles
5. Review ConfigLoader lazy initialization

### Low Priority
6. Formal service registry or auto-discovery
7. Metrics/logging service layers

## Analysis Document

For detailed analysis with code examples, patterns, and concrete refactoring opportunities, see:
**EFFECT_DI_ANALYSIS.md** (547 lines)

This document includes:
- Detailed explanation of each service
- Concrete examples of prop-drilling impact
- Before/after comparisons
- Recommended refactoring approaches
- Priority matrix of improvements

## Conclusion

The pg-sourcerer codebase has a solid foundation with Context.Tag and Layer patterns correctly implemented for most services. The main architectural improvement would be to replace the PluginContext wrapper with direct Effect-based dependencies, allowing plugins to be first-class Effects. This would reduce coupling, improve extensibility, and align with Effect's design philosophy.

The current implementation works well and demonstrates good understanding of Effect concepts. The recommendations above represent optimization opportunities rather than critical issues.

