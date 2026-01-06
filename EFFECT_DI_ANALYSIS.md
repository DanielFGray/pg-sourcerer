# pg-sourcerer: Effect DI Analysis & Optimization Opportunities

## Executive Summary

The pg-sourcerer codebase demonstrates **good usage of Effect's Context.Tag pattern** for core services, but has several **missed opportunities** where explicit parameter passing (prop-drilling) could be replaced with Effect's context system. The codebase shows the architecture is well-intentioned, but the implementation could be more leveraging of Effect's capabilities for cleaner, more composable code.

---

## 1. Current Service Architecture

### Properly Implemented Services (Context.Tag Pattern)

#### 1.1 Inflection Service
**File**: `src/services/inflection.ts`

```typescript
export class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}
export const InflectionLive = Layer.succeed(Inflection, liveInflection)
```

✅ **Well done**:
- Defined as Context.Tag
- Live and Stub layers provided
- Used correctly in PluginRunner via `yield* Inflection`
- IRBuilderSvc depends on it properly

#### 1.2 Emissions Service
**File**: `src/services/emissions.ts`

```typescript
export class Emissions extends Context.Tag("Emissions")<Emissions, EmissionBuffer>() {}
export const EmissionsLive = Layer.sync(Emissions, () => createEmissionBuffer())
```

✅ **Well done**:
- Context.Tag pattern
- Properly scoped - created fresh per run
- Singleton pattern appropriate here

#### 1.3 Symbols Service
**File**: `src/services/symbols.ts`

```typescript
export class Symbols extends Context.Tag("Symbols")<Symbols, SymbolRegistry>() {}
export const SymbolsLive = Layer.sync(Symbols, () => createSymbolRegistry())
```

✅ **Well done**:
- Context.Tag pattern
- Fresh instance per run (correct for mutable registry)

#### 1.4 Type Hints Service
**File**: `src/services/type-hints.ts`

```typescript
export class TypeHints extends Context.Tag("TypeHints")<TypeHints, TypeHintRegistry>() {}
export function TypeHintsLive(hints: readonly TypeHint[]) {
  return Layer.succeed(TypeHints, createTypeHintRegistry(hints))
}
```

✅ **Well done**:
- Context.Tag pattern
- Parametric factory function for configuration
- Good layering pattern

#### 1.5 File Writer Service
**File**: `src/services/file-writer.ts`

```typescript
export class FileWriterSvc extends Context.Tag("FileWriter")<FileWriterSvc, FileWriter>() {}
export const FileWriterLive = Layer.succeed(FileWriterSvc, createFileWriter())
```

✅ **Well done**:
- Context.Tag pattern
- Dependencies on FileSystem and Path from @effect/platform are properly yielded

#### 1.6 IR Builder Service
**File**: `src/services/ir-builder.ts`

```typescript
export class IRBuilderSvc extends Context.Tag("IRBuilder")<IRBuilderSvc, IRBuilder>() {}
```

✅ **Well done**:
- Context.Tag pattern
- Properly depends on Inflection service
- Uses Effect.Service pattern for modern Effect dependency injection

#### 1.7 Plugin Runner Service
**File**: `src/services/plugin-runner.ts`

```typescript
export class PluginRunner extends Effect.Service<PluginRunner>()("PluginRunner", {
  effect: Effect.gen(function* () {
    const inflection = yield* Inflection;
    // ...
  }),
  dependencies: [InflectionLive],
}) {}
```

✅ **Well done**:
- Modern Effect.Service pattern
- Properly depends on InflectionLive layer
- Dependencies declared in service definition

---

## 2. Prop-Drilling: The Main Opportunity

### THE PROBLEM: PluginContext

**File**: `src/services/plugin-context.ts`

```typescript
export interface PluginContextDeps {
  readonly ir: SemanticIR
  readonly inflection: CoreInflection
  readonly symbols: SymbolRegistry
  readonly typeHints: TypeHintRegistry
  readonly emissions: EmissionBuffer
  readonly artifacts: Map<CapabilityKey, Artifact>
  readonly pluginName: string
}

export function createPluginContext(deps: PluginContextDeps): PluginContext {
  // ... manually wire up all 8 dependencies into PluginContext object
}
```

**Location of prop-drilling**: `src/services/plugin-runner.ts` lines 295-313

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

### Why This Is Prop-Drilling

The pattern here is:
1. **PluginRunner** creates an opaque object (**PluginContext**)
2. Plugins receive the object, extract what they need
3. All 6+ dependencies are manually wrapped into this single parameter
4. The **Plugin interface** expects this specific shape, forcing all plugins to couple to it

This is a **vendor lock-in pattern**:
- Plugins can only access services through PluginContext
- PluginContext is a fixed interface that can't easily change
- New services require modifying PluginContext, then all plugins

### The Better Way (Effect DI)

Instead of creating an opaque PluginContext object, plugins should be Effects that **directly yield services from the context**:

```typescript
// Current approach (plugin-runner decides what to give)
interface PluginContext {
  ir: SemanticIR
  inflection: CoreInflection
  symbols: SymbolRegistry
  // ... etc
}

type Plugin = (ctx: PluginContext, config: TConfig) => Effect<void>

// Better approach (plugins request what they need)
interface PluginRuntime {
  // No dependency list - Effects naturally request services
}

type Plugin = (config: TConfig) => 
  Effect<void, PluginExecutionFailed, Inflection | Symbols | Emissions | ...>
```

---

## 3. IR Builder: Parameter Passing in Pure Functions

**File**: `src/services/ir-builder.ts`

The IR builder has many helper functions that pass `inflection` through multiple call chains:

```typescript
// Line 76-80: buildField signature
function buildField(
  attr: PgAttribute,
  tags: SmartTags,
  inflection: CoreInflection,  // <-- passed explicitly
  kind: ShapeKind
): Field

// Line 141-146: buildShape signature  
function buildShape(
  entityName: string,
  kind: ShapeKind,
  attributes: readonly PgAttribute[],
  attributeTags: ReadonlyMap<string, SmartTags>,
  inflection: CoreInflection  // <-- passed again
): Shape

// Line 253-256: buildEntity signature
function buildEntity(
  pgClass: PgClass,
  inflection: CoreInflection,  // <-- passed again
  entityNameLookup: ReadonlyMap<string, string>
): Effect.Effect<Entity, TagParseError>
```

Call chain example (line 279-282):
```typescript
const rowShape = buildShape(name, "row", attributes, attributeTags, inflection)
// ... later
insert: buildShape(name, "insert", attributes, attributeTags, inflection),
update: buildShape(name, "update", attributes, attributeTags, inflection),
patch: buildShape(name, "patch", attributes, attributeTags, inflection),
```

### Why This Works BUT Could Be Better

**Current state**: Pure functions with explicit parameters
- ✅ Good for testing (no dependencies hidden)
- ✅ Composable
- ❌ Repetitive parameter passing
- ❌ Hard to add new dependencies (must update all function signatures)
- ❌ Not truly "pure" if inflection is stateless

**Issue**: The functions `buildField`, `buildShape`, `buildEntity` are pure but need `inflection`. They're called from within an `Effect.gen`, which already has access to services.

### Opportunity: Use Reader Pattern

These pure functions could leverage Reader monad pattern OR be pulled into the Effect context:

```typescript
// Option 1: Keep pure but use Reader-style (functional programming)
function buildField(
  attr: PgAttribute,
  tags: SmartTags,
  kind: ShapeKind
): (inflection: CoreInflection) => Field

// Option 2: Move to Effect context (simpler for this codebase)
function buildField(
  attr: PgAttribute,
  tags: SmartTags,
  kind: ShapeKind
): Effect<Field, never, Inflection>  // Requires Inflection service
```

**Current callsites** in `buildEntity` (line 253-316):
```typescript
return Effect.gen(function* () {
  // ... 
  const rowShape = buildShape(name, "row", attributes, attributeTags, inflection)
  // Could become:
  const rowShape = buildShape(name, "row", attributes, attributeTags)
  // if buildShape returns Effect<Shape, TagParseError, Inflection>
})
```

---

## 4. Where Layering Is Good

### 4.1 Test Composition with @effect/vitest

**File**: `src/__tests__/plugin-runner.test.ts`

```typescript
layer(PluginRunner.Default)("PluginRunner", (it) => {
  it.effect("expands hierarchical capabilities", () =>
    Effect.gen(function* () {
      const runner = yield* PluginRunner
      // Test code here - PluginRunner automatically available
    })
  )
})
```

✅ **Excellent pattern**:
- Tests declare service dependencies via `layer()` wrapper
- Services are automatically provided
- No manual layer composition needed in tests
- All tests in suite share same layer configuration

### 4.2 Integration Test Layer Composition

**File**: `src/__tests__/ir-builder.integration.test.ts` (lines 41-46)

```typescript
const buildIR = (schemas: readonly string[]) =>
  Effect.gen(function* () {
    const inflection = yield* Inflection
    const builder = createIRBuilderService(inflection)
    return yield* builder.build(introspection, { schemas })
  }).pipe(Effect.provide(InflectionLive))
```

✅ **Good**:
- Manually provides a single layer when needed
- Shows how to compose effects with services
- Simple for one-off integration tests

---

## 5. Where DI Could Be Better: Config & Initialization

**File**: `src/services/config-loader.ts`

```typescript
export class ConfigLoaderService extends Context.Tag("ConfigLoader")<...>() {}

export function createConfigLoader(): ConfigLoader {
  const lc = createLilconfig()
  return {
    load: options => Effect.gen(function* () {
      // Async config loading...
    })
  }
}

export const ConfigLoaderLive = Layer.succeed(ConfigLoaderService, createConfigLoader())
```

⚠️ **Observation**:
- ConfigLoaderLive is created at module load time
- All instances share the same lilconfig instance
- This is fine, but lilconfig is created eagerly
- Could be lazier with `Layer.sync(() => createConfigLoader())`

---

## 6. Database Introspection: Missing Service

**File**: `src/services/introspection.ts`

```typescript
export class DatabaseIntrospectionService extends Context.Tag(
  "DatabaseIntrospection"
)<DatabaseIntrospectionService, DatabaseIntrospection>() {}

export const DatabaseIntrospectionLive = Effect.sync(() =>
  createDatabaseIntrospection()
)
```

✅ **Service tag exists**
⚠️ **But**: No actual Layer created! 

Current usage (line 145-148):
```typescript
export function introspectDatabase(
  options: IntrospectOptions
): Effect.Effect<Introspection, ...> {
  return createDatabaseIntrospection().introspect(options)
}
```

This **completely bypasses** the Effect context. It should be:

```typescript
export const introspectDatabase = (options: IntrospectOptions) =>
  Effect.gen(function* () {
    const svc = yield* DatabaseIntrospectionService
    return yield* svc.introspect(options)
  })

export const DatabaseIntrospectionLive = Layer.sync(
  DatabaseIntrospectionService,
  () => createDatabaseIntrospection()
)
```

---

## 7. Smart Tags Parser: Pure Function, Not a Service

**File**: `src/services/smart-tags-parser.ts`

```typescript
export function parseSmartTags(
  comment: string | null | undefined,
  context: TagContext
): Effect.Effect<ParsedComment, TagParseError> {
  // Pure parsing logic wrapped in Effect
}
```

✅ **Correct pattern**:
- Stateless function, no need for service
- Wraps pure logic in Effect for error handling
- Called throughout the codebase without DI

---

## 8. Concrete Examples of Prop-Drilling Impact

### Example 1: Adding a New Service to Plugins

**Scenario**: We want plugins to access a new "MetricsCollector" service.

**Current approach** (requires changes in multiple places):
```typescript
// 1. Add to PluginContextDeps
export interface PluginContextDeps {
  // ... existing fields
  readonly metrics: MetricsCollector  // NEW
}

// 2. Update createPluginContext
export function createPluginContext(deps: PluginContextDeps): PluginContext {
  return {
    // ... existing fields
    metrics: deps.metrics,  // NEW
  }
}

// 3. Update PluginContext interface
export interface PluginContext {
  // ... existing fields
  readonly metrics: MetricsCollector  // NEW
}

// 4. Update PluginRunner to pass it
const ctx = createPluginContext({
  ir,
  inflection,
  symbols,
  typeHints,
  emissions,
  artifacts,
  pluginName: plugin.name,
  metrics,  // NEW
})

// 5. ALL plugins must now either ignore or use metrics
// They're forced to know about it via the interface
```

**Better approach** (with Effect DI):
```typescript
// Plugin becomes an Effect that yields what it needs
interface Plugin<TConfig> {
  run: (config: TConfig) => Effect<void, PluginExecutionFailed>
}

// In plugin implementation:
const myPlugin: Plugin = {
  run: (config) => Effect.gen(function* () {
    const ir = yield* IR  // Gets IR if needed
    const metrics = yield* MetricsCollector  // Gets metrics if needed
    // ... only requests what it needs
  })
}

// PluginRunner doesn't need to know about all services
// It just runs the effect - the layer handles dependencies
```

### Example 2: Testing a Plugin in Isolation

**Current approach** (must stub entire PluginContext):
```typescript
it("generates correct types", () => {
  const stubContext: PluginContext = {
    ir: createTestIR(),
    inflection: createTestInflection(),
    symbols: createTestSymbolRegistry(),
    typeHints: emptyTypeHintRegistry,
    emit: () => {},
    appendEmit: () => {},
    getArtifact: () => undefined,
    setArtifact: () => {},
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    pluginName: "test-plugin",
  }
  
  const result = plugin.run(stubContext, config)
})
```

**Better approach** (with Effect DI):
```typescript
layer(IR.TestLayer, Inflection.TestLayer, Symbols.TestLayer)(
  "MyPlugin tests", 
  (it) => {
    it.effect("generates correct types", () => 
      Effect.gen(function* () {
        const result = yield* plugin.run(config)
        expect(result).toBeDefined()
      })
    )
  }
)
```

---

## 9. Summary: Missed Opportunities

| Area | Current Pattern | Opportunity | Impact |
|------|-----------------|-------------|--------|
| **PluginContext** | Opaque object passed to plugins | Make plugins Effects that yield services | Higher modularity, easier to extend |
| **IR Builder** | Pure functions with explicit params | Use Effect Reader or yield Inflection | Less parameter passing, cleaner code |
| **Introspection** | Bypasses service layer entirely | Create proper Layer and use in context | Consistent with architecture |
| **Config Loader** | Eager singleton creation | Use Layer.sync for lazy initialization | Better resource management |
| **Test Layers** | Manually composed per test | Create reusable test layer bundles | Less boilerplate in tests |

---

## 10. Recommended Refactoring Priority

### High Priority (Architecture Improvement)
1. **Convert Plugin interface** to use Effect-based dependencies
2. **Create DatabaseIntrospectionLive Layer** and use in context
3. **Make IR Builder functions yield Inflection** instead of taking it as param

### Medium Priority (Code Quality)
4. **Extract reusable test layers** for common test scenarios
5. **Review ConfigLoader** initialization pattern
6. **Add SmartTagsParser as optional service** (currently not needed, but future-proofing)

### Low Priority (Polish)
7. Review TypeHints parametric factory pattern (already good)
8. Add metrics/logging as services (future work)

---

## Key Takeaways

1. **Services are well-defined**: The Context.Tag pattern is used correctly for most services
2. **PluginContext is the pain point**: It's an artificial "context object" that duplicates what Effect DI already does
3. **Parameter passing is a symptom**: Functions like buildShape() pass inflection explicitly because it's not in the Effect context
4. **Test composition is strong**: Using @effect/vitest's `layer()` is the right pattern
5. **Introspection is inconsistent**: Has a service tag but doesn't use Layer, bypassing DI entirely

The codebase would benefit most from **making plugins first-class Effects** rather than plain functions receiving a context object. This aligns with Effect's design philosophy and eliminates the need for the artificial PluginContext wrapper.

