# RFC: Plugin System Simplifications & TUI Integration

**RFC**: 2025-01
**Status**: Draft
**Author**: OpenCode Assistant

## Executive Summary

This RFC proposes simplifications to the plugin system that:
1. Enable TUI integration via an optional `configure` phase
2. Reduce architectural complexity by removing legacy patterns
3. Add soft dependencies (`enhancedBy`) for optional capabilities
4. Improve debuggability by eliminating thread-local state

The changes are **backward compatible**—existing plugins work unchanged.

## Problem Statement

### Current Issues

1. **TUI Cannot Integrate Cleanly**
   - Plugins only have `declare` and `render` phases
   - TUI needs an interactive pre-processing phase
   - No way to produce user selections that influence other plugins

2. **Architectural Complexity**
   - `renderWithImports` is awkward—runtime must track references that plugins should own
   - SymbolRegistry has dual sync/async APIs
   - Thread-local `CurrentCapabilities` is error-prone
   - Validation is separate from collection (collect-then-validate vs fail-fast)

3. **Inflexible Dependencies**
   - `consumes` is all-or-nothing—no soft dependencies
   - Query plugins can't gracefully degrade when optional features are missing

### Examples of Current Pain

```typescript
// Plugin must list imports upfront—awkward
renderWithImports: ["type:User", "type:Post"];

// Runtime manually tracks references—fragile
for (const cap of plugin.renderWithImports) {
  registry.import(cap).ref();
}

// Sync API that throws vs async API that returns Effect
const handle1 = registry.import("type:User");  // Sync, throws
const handle2 = registry.getHandle("type:User"); // Async, typed error

// Thread-local state—easy to forget to clear
registry.setCurrentCapabilities(plugin.provides);
// ... plugin renders ...
registry.clearCurrentCapabilities();  // FORGOTTEN? Bug!
```

## Proposed Changes

### 1. Remove `renderWithImports`

**Before:**
```typescript
interface Plugin {
  renderWithImports?: Capability[];
  render: Effect<...>;
}
```

**After:**
```typescript
interface Plugin {
  // Removed—no more declarative imports
  render: Effect<...>;
}
```

**Migration:** Plugins call `registry.import()` in their render logic:
```typescript
render: Effect.gen(function* () {
  const userType = yield* registry.import("type:User");
  // ref() and call() track references naturally
})
```

---

### 2. Unify SymbolRegistry API (Async Only)

**Before:**
```typescript
interface SymbolRegistry {
  getHandle(capability): Effect<SymbolHandle, CapabilityNotFound>;
  import(capability): SymbolHandle;  // Sync, throws
}
```

**After:**
```typescript
interface SymbolRegistry {
  import(capability): Effect<SymbolHandle, CapabilityNotFound>;  // All async
}
```

**Benefits:**
- One API to learn
- Typed errors throughout
- Consistent with Effect patterns

---

### 3. Eliminate Thread-Local CurrentCapabilities

**Before:**
```typescript
// Runtime maintains thread-local state
registry.setCurrentCapabilities(plugin.provides);
// ... plugin renders ...
registry.clearCurrentCapabilities();
```

**After:**
```typescript
// References carry their source explicitly
interface Reference {
  from: { plugin: string; capability: Capability };
  to: { plugin: string; capability: Capability };
}

// recordReference takes source explicitly
registry.recordReference({
  from: { plugin: "types", capability: "type:User" },
  to: { plugin: "queries", capability: "query:findUser" }
});
```

---

### 4. Add Optional `configure` Phase

**Before:**
```typescript
interface Plugin {
  declare: Effect<...>;
  render: Effect<...>;
}
```

**After:**
```typescript
interface Plugin<Config = unknown> {
  phase?: "configure" | "declare";
  provides: Capability[];
  consumes?: Capability[];
  enhancedBy?: Capability[];
  configSchema?: Schema<Config>;
  
  // Optional—runs in "configure" phase
  configure?: Effect<UserSelections, ConfigureError, ConfigureServices>;
  
  // Required—runs in "declare" phase
  declare: Effect<SymbolDeclaration[], DeclareError, DeclareServices>;
  
  // Required—runs in "render" phase
  render: Effect<RenderedSymbol[], RenderError, RenderServices>;
}
```

**TUI Integration:**
```typescript
export const tuiPlugin: Plugin = {
  name: "query-builder-tui",
  phase: "configure",
  provides: ["user-selections"],
  
  configure: Effect.gen(function* () {
    const ir = yield* IR;
    const selections = yield* runInteractiveBuilder(ir);
    return selections;
  }),
};
```

---

### 5. Add Soft Dependencies (`enhancedBy`)

**Before:**
```typescript
interface Plugin {
  consumes?: Capability[];  // Hard fail if missing
}
```

**After:**
```typescript
interface Plugin {
  consumes?: Capability[];   // Hard fail if missing
  enhancedBy?: Capability[]; // Uses if available, degrades gracefully
}
```

**Usage:**
```typescript
export const sqlQueriesPlugin: Plugin = {
  name: "sql-queries",
  provides: ["queries"],
  consumes: ["query-ideas", "types"],
  enhancedBy: ["user-selections"],  // Optional—works without TUI
  
  declare: Effect.gen(function* () {
    const registry = yield* SymbolRegistry;
    const ideas = registry.query("query-ideas");
    
    // Check if user selections exist
    const userSelections = yield* Effect.flatMap(
      registry.find("user-selections"),
      selections => Effect.succeed(Some(selections)),
      () => Effect.succeed(None)
    );
    
    // Use selections if available, otherwise generate default ideas
    return userSelections._tag === "Some"
      ? generateFromSelections(userSelections.value)
      : generateDefaultIdeas(ideas);
  }),
};
```

---

### 6. Phase-Aware Orchestration

**Before (hardcoded):**
```typescript
for (const plugin of plugins) {
  yield* plugin.declare;
}
yield* validateAll();
yield* assignFiles();
for (const plugin of plugins) {
  yield* plugin.render;
}
```

**After:**
```typescript
const PHASES = ["configure", "declare", "render"] as const;

for (const phase of PHASES) {
  const phasePlugins = plugins.filter(p => {
    const pluginPhase = p.phase ?? (phase === "configure" ? "configure" : "declare");
    return pluginPhase === phase;
  });
  
  for (const plugin of phasePlugins) {
    const effect = phase === "configure" 
      ? plugin.configure ?? Effect.unit()
      : phase === "declare" 
        ? plugin.declare 
        : plugin.render;
    yield* effect;
  }
}

yield* validateAll();
yield* assignFiles();
```

---

### 7. Inline Validation (Fail-Fast)

**Before (collect-then-validate):**
```typescript
const allDecls: SymbolDeclaration[] = [];
for (const plugin of plugins) {
  const decls = yield* plugin.declare;
  allDecls.push(...decls);
}
yield* validateAll(plugins, registry);  // All at once
```

**After (fail-fast):**
```typescript
for (const plugin of plugins) {
  const decls = yield* Effect.validate(plugin.declare);
  yield* registry.registerAll(decls);  // Inline validation
}
```

---

## UserSelections Capability

The TUI plugin produces a capability that other plugins can consume:

```typescript
interface UserSelections {
  tables: string[];
  columns: Map<string, string[]>;  // entity → columns
  joins: JoinPath;
  filters: FilterCondition[];
}

// TUI plugin provides:
provides: ["user-selections"];

// Query plugins can consume:
enhancedBy: ["user-selections"];
```

---

## Simplified Plugin Interface

```typescript
interface Plugin<Config = unknown> {
  /** Plugin name for debugging */
  name: string;
  
  /** Which phase to run in—configure plugins run before declare plugins */
  phase?: "configure" | "declare";
  
  /** Capabilities this plugin provides */
  provides: Capability[];
  
  /** Hard dependencies—fails if missing */
  consumes?: Capability[];
  
  /** Soft dependencies—uses if available, degrades gracefully */
  enhancedBy?: Capability[];
  
  /** Configuration schema for this plugin */
  configSchema?: Schema<Config>;
  
  /** Optional interactive configuration phase */
  configure?: Effect<UserSelections, ConfigureError, ConfigureServices>;
  
  /** Required—declare phase */
  declare: Effect<SymbolDeclaration[], DeclareError, DeclareServices>;
  
  /** Required—render phase */
  render: Effect<RenderedSymbol[], RenderError, RenderServices>;
}
```

---

## Migration Guide

### Existing Plugins (No Changes Required)

| Plugin | Migration |
|--------|-----------|
| `typesPlugin` | Works unchanged (no configure, phase defaults to declare) |
| `zodPlugin` | Works unchanged |
| `sqlQueriesPlugin` | Works unchanged |

### Query Plugins (Optional Enhancement)

```typescript
// Before
export const sqlQueriesPlugin: Plugin = {
  name: "sql-queries",
  provides: ["queries"],
  consumes: ["query-ideas", "types"],
  // ...
};

// After (optional—works without TUI too)
export const sqlQueriesPlugin: Plugin = {
  name: "sql-queries",
  provides: ["queries"],
  consumes: ["query-ideas", "types"],
  enhancedBy: ["user-selections"],  // NEW
  
  declare: Effect.gen(function* () {
    const registry = yield* SymbolRegistry;
    const ideas = registry.query("query-ideas");
    
    // NEW: Check for user selections
    const selections = yield* registry.tryFind("user-selections");
    
    return selections
      ? generateFromSelections(selections, ideas)
      : generateDefaultIdeas(ideas);
  }),
};
```

### New TUI Plugin

```typescript
export const tuiPlugin: Plugin = {
  name: "query-builder-tui",
  phase: "configure",
  provides: ["user-selections"],
  
  configure: Effect.gen(function* () {
    const ir = yield* IR;
    return yield* runInteractiveBuilder(ir);
  }),
};
```

---

## Implementation Plan

### Phase 1: Core Simplifications (No New Features)

1. **Remove `renderWithImports`**
   - Update `Plugin` interface
   - Update `orchestrator.ts` to not track imports
   - Update existing plugins to call `registry.import()` in render

2. **Unify SymbolRegistry to Async**
   - Remove sync `import()` method
   - Update all call sites to use Effect-based API
   - Update error handling

3. **Eliminate CurrentCapabilities**
   - Update `SymbolRegistry.recordReference()` to take explicit source
   - Remove `setCurrentCapabilities()` / `clearCurrentCapabilities()`
   - Update emit phase to read explicit references

4. **Inline Validation**
   - Move validation into collection loop
   - Remove separate `validateAll()` call or keep for capability-level validation

**Estimated:** 2-3 days

---

### Phase 2: Phase System

5. **Add `phase` Field to Plugin**
   - Update `Plugin` interface
   - Update type definitions

6. **Phase-Aware Orchestration**
   - Refactor `runPlugins()` to iterate by phase
   - Support `configure` → `declare` → `render` order
   - Default phase based on which methods are defined

**Estimated:** 1-2 days

---

### Phase 3: Soft Dependencies

7. **Add `enhancedBy` to Plugin**
   - Update `Plugin` interface
   - Add `enhancedBy` to capability validation
   - Differentiate hard vs soft in validation errors

8. **Add `registry.tryFind()` Helper**
   - For optional capabilities that may not exist
   - Returns `Effect<Option<SymbolHandle>, ...>`

**Estimated:** 1 day

---

### Phase 4: TUI Plugin

9. **Define UserSelections Type**
   - Create `src/plugins/tui/types.ts`
   - Define `UserSelections` interface

10. **Create TUI Plugin**
    - Move `scripts/query-builder-tui.ts` logic to plugin
    - Use `phase: "configure"`
    - Produce `user-selections` capability

11. **Update Query Plugins to Use Selections**
    - `sql-queries` plugin
    - `kysely-queries` plugin
    - `kysely-types` plugin

**Estimated:** 2-3 days

---

## Backward Compatibility

### What's Preserved

| Aspect | Compatibility |
|--------|---------------|
| Existing plugin interface | ✅ Preserved (configure is optional) |
| SymbolRegistry API | ⚠️ Breaking—sync methods removed |
| `renderWithImports` | ❌ Removed—plugins must update |
| CurrentCapabilities | ❌ Removed—no migration path needed |

### Breaking Changes

1. **Sync SymbolRegistry methods** — Update call sites to use Effect-based API
2. **`renderWithImports`** — Remove from plugins, call `registry.import()` in render

---

## Open Questions

### Q1: Should `configure` plugins be allowed to modify IR?

**Options:**
- **No** — configure produces separate `UserSelections` artifact
- **Yes** — configure receives IR service, can annotate/modify it

**Implications:**
- Modifying IR requires write access to IR service
- Downstream plugins see modified IR
- More flexible but harder to reason about

**Recommendation:** No—keep IR as schema source of truth, selections as separate artifact

---

### Q2: Should configure phase allow multiple passes?

**Options:**
- **No** — single configure pass, then proceed
- **Yes** — configure can run multiple times (e.g., iterative refinement)

**Implications:**
- Multiple passes allow "try query → refine → try again" workflow
- More complex orchestration
- TUI may want iterative selection

**Recommendation:** Single pass for MVP, evaluate multi-pass later

---

### Q3: How do we handle TUI cancellation?

**Options:**
- **Skip TUI** — proceed with default generation
- **Fail pipeline** — TUI cancellation aborts entire generation

**Implications:**
- Skip allows partial automation (TUI optional)
- Fail ensures user intent is respected

**Recommendation:** Skip by default, add config flag to fail if needed

---

### Q4: Should user-selections be editable after generation?

**Options:**
- **No** — selections consumed once during declare
- **Yes** — selections persisted, can be re-edited

**Implications:**
- Re-editing requires cache/invalidation logic
- Supports iterative workflow (generate → tweak → regenerate)
- More complex state management

**Recommendation:** No for MVP—selections consumed once, re-run TUI to change

---

### Q5: Should TUI be a plugin or separate binary?

**Options:**
- **Plugin** — runs as part of normal pipeline
- **Separate** — standalone binary that generates config

**Implications:**
- Plugin integrates with plugin lifecycle
- Separate binary works without plugin infrastructure
- Plugin requires configure phase (this RFC)
- Separate requires config file format

**Recommendation:** Plugin (this RFC's approach) for tighter integration

---

## Alternatives Considered

### Alternative 1: Pre-processing Binary

Run TUI as separate binary before main generation:
```bash
bun run tui --schema=db.ts --output=selections.json
bun run generate --selections=selections.json
```

**Pros:** No plugin changes needed
**Cons:** Two commands, state must be persisted, less integrated

---

### Alternative 2: IR Annotation

TUI annotates IR with selections:
```typescript
interface AnnotatedIR extends SemanticIR {
  userSelections: UserSelections;
}
```

**Pros:** No new phases
**Cons:** IR becomes mutable, plugins must check for selections

---

### Alternative 3: Config-Driven Selection

User selections in config file:
```typescript
export default {
  queries: {
    select: {
      users: { columns: ["id", "email"] },
      orders: { columns: ["*"], joins: ["users"] },
    },
  },
};
```

**Pros:** No interactive TUI needed
**Cons:** Not interactive, config syntax is cumbersome

---

## References

- `docs/SYMBOLS_CONJURE_REDESIGN.md` - Current architecture
- `docs/QUERY_PATTERNS_PLAN.md` - Related query pattern heuristics
- `src/runtime/orchestrator.ts` - Current phase implementation
- `src/runtime/types.ts` - Plugin interface
- `src/runtime/registry.ts` - SymbolRegistry

---

## Appendix: Service Types After Changes

```typescript
// Services available in configure phase
type ConfigureServices = IR | Config;

// Services available in declare phase
type DeclareServices = ConfigureServices | Inflection | TypeHints;

// Services available in render phase
type RenderServices = DeclareServices | SymbolRegistry;
```

---

## Appendix: Migration Checklist

- [ ] Remove `renderWithImports` from Plugin interface
- [ ] Remove sync `import()` from SymbolRegistry
- [ ] Add explicit source to `recordReference()`
- [ ] Remove `setCurrentCapabilities()` / `clearCurrentCapabilities()`
- [ ] Refactor `runPlugins()` for phase-aware execution
- [ ] Add `phase` field to Plugin interface
- [ ] Add `enhancedBy` field to Plugin interface
- [ ] Add `registry.tryFind()` helper
- [ ] Define `UserSelections` type
- [ ] Create TUI plugin with `configure` phase
- [ ] Update `sql-queries` plugin to use selections
- [ ] Update `kysely-*` plugins to use selections
- [ ] Update documentation
- [ ] Add integration tests
