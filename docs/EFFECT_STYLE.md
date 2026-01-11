# Effect-TS Style Guide

Effect is functional TypeScript. Think of it as a different language: there is no `for(..)` loop

## Two Pipe Styles

```typescript
// Effects: method .pipe()
buildProviderMap(plugins).pipe(
  Effect.tap(checkRequirements),
  Effect.flatMap(topoSort)
)

// Pure transforms: use native methods where possible
plugins.map(p => p.name).filter(Boolean))
use effect pipes if necessary
```

## Core Patterns

| Do | Don't |
|----|-------|
| `effect.pipe(Effect.map(...))` | `pipe(effect, Effect.map(...))` |
| `plugins.map(p => p.name).filter(Boolean))` | `pipe(data, Array.map(...),Array.filter(..))` |
| `import { Array, Option }` | `import { Array as A }` |
| `Effect.forEach(items, fn)` | `for` loop with `yield*` |
| `Effect.reduce(items, init, fn)` | Build then validate |

## Extract Pure Logic

```typescript
// Pure: no Effect wrapper needed
const capabilityPairs = (plugins: ConfiguredPlugin[]) =>
  plugins.flatMap(p => p.plugin.provides.map(cap => [cap, p.plugin.name] as const))

// Effectful: only where needed
const buildProviderMap = (plugins: ConfiguredPlugin[]) =>
  Effect.reduce(capabilityPairs(plugins), HashMap.empty(), (map, [cap, name]) =>
    HashMap.has(map, cap)
      ? Effect.fail(new Conflict({ cap }))
      : Effect.succeed(HashMap.set(map, cap, name))
  )
```

## Anti-Patterns

```typescript
// BAD: imperative loop in gen
Effect.gen(function* () {
  const results = []
  for (const item of items) {
    results.push(yield* process(item))
  }
  return results
})

// GOOD: declarative
Effect.forEach(items, process)

// BAD: unnecessary succeed
getUser().pipe(Effect.flatMap(u => Effect.succeed(u.name)))

// GOOD: use map for pure transforms
getUser().pipe(Effect.map(u => u.name))

// BAD: nested gens
Effect.gen(function* () {
  const a = yield* Effect.gen(function* () {
    return yield* getX()
  })
})

// GOOD: flatten
getX().pipe(Effect.map(transform))
```

## When Effect.gen Is Appropriate

Multiple dependent yields or complex control flow:

```typescript
Effect.gen(function* () {
  const config = yield* loadConfig()
  const db = yield* connectDatabase(config.connectionString)
  const schema = yield* introspect(db, config.schemas)
  return buildIR(schema)
})
```

Simple chains should use pipe:

```typescript
// Instead of gen with 2 yields
getA().pipe(Effect.flatMap(processA))
```

## Services

```typescript
// Simple: Context.Tag + Layer
class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}
export const InflectionLive = Layer.succeed(Inflection, { /* impl */ })

// With dependencies: Effect.Service
class Logger extends Effect.Service<Logger>()("Logger", {
  effect: Effect.gen(function* () {
    const { prefix } = yield* Prefix
    return { info: (msg) => Effect.log(`[${prefix}] ${msg}`) }
  }),
  dependencies: [Prefix.Default]
}) {}
```

## Errors

```typescript
// Define
class CapabilityConflict extends Data.TaggedError("CapabilityConflict")<{
  readonly capability: string
}> {}

// Catch
effect.pipe(Effect.catchTag("CapabilityConflict", handleConflict))
```

## Option Handling

```typescript
// BAD: null checks after Option
const opt = Array.findFirst(items, pred)
if (Option.isNone(opt)) return
const value = opt.value

// GOOD: pattern match
pipe(
  Array.findFirst(items, pred),
  Option.match({
    onNone: () => handleMissing(),
    onSome: (value) => handleFound(value)
  })
)
```

## Quick Reference

| Want to... | Use |
|------------|-----|
| Transform value | `Effect.map(fn)` |
| Chain effects | `Effect.flatMap(fn)` |
| Side effect | `Effect.tap(fn)` |
| Map array | `Effect.forEach(items, fn)` |
| Reduce with failure | `Effect.reduce(items, init, fn)` |
| Boolean branch | `Effect.if(cond, {onTrue, onFalse})` |
| Catch error | `Effect.catchTag("Tag", fn)` |
| Provide service | `Effect.provide(layer)` |

## Mutable Collections

Use `MutableHashMap`/`MutableList` for single-pass accumulation. Prefer `Effect.forEach` over converting to arrays:

```typescript
const map = MutableHashMap.empty<string, number>()
MutableHashMap.set(map, "key", 1)

// Iterate with Effect.forEach (lazy, no intermediate array)
Effect.forEach(MutableHashMap.keys(map), (key) =>
  Effect.gen(function* () {
    const value = MutableHashMap.get(map, key)
    // ...
  })
)
```

| Scenario | Use |
|----------|-----|
| Building during traversal | Mutable collections |
| Pure transforms | Immutable `HashMap`, `Array` |
| Shared across fibers | `Ref<HashMap>` |
