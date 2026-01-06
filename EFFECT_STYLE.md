# Effect-TS Style Guide

**Read this before writing or modifying any Effect code.**

Effect is a functional language embedded in TypeScript. This guide covers the specific conventions for this codebase.

## Quick Reference

| Pattern | Use | Avoid |
|---------|-----|-------|
| Effect chains | `effect.pipe(Effect.map(...))` | `pipe(effect, Effect.map(...))` |
| Data transforms | `pipe(data, Array.map(...))` | `data.pipe(...)` (doesn't exist) |
| Imports | `import { Array, Option }` | `import { Array as A }` |
| Branching | `Effect.if(cond, { onTrue, onFalse })` | `if/else` blocks returning Effects |
| Find first failure | `Array.findFirst` + `Option.match` | `for` loop with early return |
| Validate during build | `Effect.reduce` | Build then validate |
| Service definition | `Effect.Service` or `Context.Tag` | Classes with `new` |

## Core Rules

### Method `.pipe()` for Effects, Function `pipe()` for Data

```typescript
// ✅ Effect values use method-style .pipe()
buildProviderMap(plugins).pipe(
  Effect.tap((providers) => checkRequirements(plugins, providers)),
  Effect.flatMap((providers) => topoSort(plugins, providers))
)

// ✅ Pure data transformations use pipe() function
const names = pipe(
  plugins,
  Array.flatMap(p => p.provides),
  Array.dedupe
)

// ❌ NEVER use pipe() function on Effect values
pipe(
  buildProviderMap(plugins),
  Effect.tap(...),  // NO!
  Effect.flatMap(...)
)
```

**Why?** Effect values have a `.pipe()` method that provides better type inference and IDE support. The `pipe()` function is for transforming plain data.

### Separate Pure from Effectful

Extract pure data transformations into standalone functions. Only wrap in Effect what actually needs it.

```typescript
// ✅ Pure function for data extraction
const capabilityPairs = (plugins: readonly ConfiguredPlugin[]) =>
  pipe(
    plugins,
    Array.flatMap(({ plugin }) =>
      pipe(
        plugin.provides,
        Array.map(cap => [cap, plugin.name] as const)
      )
    )
  )

// ✅ Effect only for the validation logic
const buildProviderMap = (plugins: readonly ConfiguredPlugin[]) =>
  Effect.reduce(
    capabilityPairs(plugins),  // Pure extraction
    HashMap.empty(),
    (map, [cap, name]) => /* validation logic */
  )
```

### Fail Early in Folds

Use `Effect.reduce` to validate during construction, not after.

```typescript
// ✅ Single-pass validation with Effect.reduce
const buildMap = (entries: readonly Entry[]) =>
  Effect.reduce(entries, HashMap.empty(), (map, entry) =>
    HashMap.has(map, entry.key)
      ? Effect.fail(new Conflict({ key: entry.key }))
      : Effect.succeed(HashMap.set(map, entry.key, entry.value))
  )

// ❌ Build then validate (two passes, harder to read)
const buildMap = (entries: readonly Entry[]) =>
  Effect.gen(function* () {
    const map = new Map()
    for (const entry of entries) {
      map.set(entry.key, entry.value)
    }
    // Now validate... but we already lost info about conflicts!
  })
```

### Find-First Pattern for Failure

Use `Array.findFirst` + `Option.match` instead of loops with early return.

```typescript
// ✅ Declarative find-first pattern
const checkRequirements = (plugins, providers) =>
  pipe(
    requirementPairs(plugins),
    Array.findFirst(([req]) => !HashMap.has(providers, req)),
    Option.match({
      onNone: () => Effect.void,
      onSome: ([req, name]) =>
        Effect.fail(new CapabilityNotSatisfied({ required: req, requiredBy: name }))
    })
  )

// ❌ Imperative loop
const checkRequirements = (plugins, providers) =>
  Effect.gen(function* () {
    for (const { plugin } of plugins) {
      for (const req of plugin.requires ?? []) {
        if (!HashMap.has(providers, req)) {
          yield* Effect.fail(new CapabilityNotSatisfied({ ... }))
        }
      }
    }
  })
```

### Effect.if for Boolean Branching

```typescript
// ✅ Effect.if for branching on boolean
Effect.if(plugins.length === 0, {
  onTrue: () => Effect.succeed([]),
  onFalse: () => processPlugins(plugins)
})

// ✅ Ternary for simple cases
isValid
  ? Effect.succeed(value)
  : Effect.fail(new Invalid({ value }))

// ❌ if/else blocks returning Effects
if (plugins.length === 0) {
  return Effect.succeed([])
} else {
  return processPlugins(plugins)
}
```

### When to Use Effect.gen

Reserve `Effect.gen` for complex control flow where pipes become unwieldy:

```typescript
// ✅ Good use of Effect.gen - multiple dependent yields
Effect.gen(function* () {
  const config = yield* loadConfig()
  const db = yield* connectDatabase(config.connectionString)
  const schema = yield* introspect(db, config.schemas)
  return buildIR(schema)
})

// ✅ Also good - try/catch recovery
Effect.gen(function* () {
  const result = yield* someEffect.pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(defaultValue))
  )
  return processResult(result)
})

// ❌ Unnecessary gen - should be pipe
Effect.gen(function* () {
  const a = yield* getA()
  const b = yield* processA(a)
  return b
})

// ✅ Better as pipe
getA().pipe(Effect.flatMap(processA))
```

## Anti-Patterns and Fixes

### Anti-Pattern: Imperative Loops in Effect.gen

```typescript
// ❌ Imperative accumulation
Effect.gen(function* () {
  const results = []
  for (const item of items) {
    const result = yield* process(item)
    results.push(result)
  }
  return results
})

// ✅ Use Effect.forEach
Effect.forEach(items, process)

// ✅ Or Effect.reduce for accumulation with logic
Effect.reduce(items, [], (acc, item) =>
  process(item).pipe(Effect.map(r => [...acc, r]))
)
```

### Anti-Pattern: Nested Effect.gen

```typescript
// ❌ Nested gens are a smell
Effect.gen(function* () {
  const a = yield* Effect.gen(function* () {
    const x = yield* getX()
    return transform(x)
  })
  return finalize(a)
})

// ✅ Flatten with pipe
getX().pipe(
  Effect.map(transform),
  Effect.map(finalize)
)
```

### Anti-Pattern: Using globalThis.Array

```typescript
// ❌ Mixing Array types
import { Array } from "effect"
const items = globalThis.Array.from(iterator)

// ✅ Use Array.fromIterable
import { Array } from "effect"
const items = Array.fromIterable(iterator)

// ✅ Or be explicit at call site if truly needed
const items = [...iterator] as readonly Item[]
```

### Anti-Pattern: Ignoring Option

```typescript
// ❌ Unsafe unwrapping
const value = Option.getOrThrow(maybeValue)

// ❌ Null checks after Option
const opt = Array.findFirst(items, predicate)
if (Option.isNone(opt)) return
const value = opt.value  // Still accessing internals

// ✅ Use Option.match
pipe(
  Array.findFirst(items, predicate),
  Option.match({
    onNone: () => handleMissing(),
    onSome: (value) => handleFound(value)
  })
)
```

### Anti-Pattern: Effect.succeed in Chains

```typescript
// ❌ Unnecessary wrapping
getUser().pipe(
  Effect.flatMap(user => Effect.succeed(user.name))
)

// ✅ Use Effect.map for pure transformations
getUser().pipe(Effect.map(user => user.name))
```

### Anti-Pattern: Effect.fail in Validation

```typescript
// ❌ Multiple Effect.fail calls in sequence
Effect.gen(function* () {
  if (!isValid(a)) yield* Effect.fail(new InvalidA())
  if (!isValid(b)) yield* Effect.fail(new InvalidB())
  // ...continues after failure?
})

// ✅ Use findFirst + fail pattern
pipe(
  [a, b, c],
  Array.findFirst(x => !isValid(x)),
  Option.match({
    onNone: () => Effect.succeed({ a, b, c }),
    onSome: (bad) => Effect.fail(new Invalid({ item: bad }))
  })
)
```

## Service Patterns

### Defining Services

For simple services with a single implementation, use `Context.Tag` + `Layer.succeed`:

```typescript
// Simple pattern: Context.Tag + Layer (preferred for most cases)
export class Inflection extends Context.Tag("Inflection")<
  Inflection,
  CoreInflection
>() {}

export const InflectionStub: CoreInflection = { /* ... */ }
export const InflectionStubLayer = Layer.succeed(Inflection, InflectionStub)
export const InflectionLive = Layer.succeed(Inflection, { /* ... */ })
```

For services needing effectful construction, dependencies, or lifecycle:

```typescript
// Effect.Service - when you need dependencies or effects
class Logger extends Effect.Service<Logger>()("Logger", {
  effect: Effect.gen(function* () {
    const { prefix } = yield* Prefix
    return { info: (msg: string) => Effect.log(`[${prefix}] ${msg}`) }
  }),
  dependencies: [Prefix.Default]
}) {}
```

### Using Services

```typescript
// In Effect.gen
Effect.gen(function* () {
  const inflection = yield* Inflection
  const name = inflection.camelCase("foo_bar")
})

// With pipe
Inflection.pipe(
  Effect.map(inflection => inflection.camelCase("foo_bar"))
)
```

## Error Handling

### Defining Errors

```typescript
import { Data } from "effect"

export class CapabilityConflict extends Data.TaggedError("CapabilityConflict")<{
  readonly message: string
  readonly capability: string
  readonly providers: readonly string[]
}> {}
```

### Catching Errors

```typescript
// Catch specific error type
effect.pipe(
  Effect.catchTag("CapabilityConflict", (err) =>
    Effect.succeed(fallbackValue)
  )
)

// Catch multiple types
effect.pipe(
  Effect.catchTags({
    CapabilityConflict: (err) => handleConflict(err),
    CapabilityCycle: (err) => handleCycle(err),
  })
)
```

## Testing with @effect/vitest

```typescript
import { it, describe, layer } from "@effect/vitest"
import { Effect } from "effect"

describe("MyService", () => {
  // Basic effect test
  it.effect("does something", () =>
    Effect.gen(function* () {
      const result = yield* someEffect
      expect(result).toBe(expected)
    })
  )
})

// Test suite with layer
layer(MyServiceLive)("with service", (it) => {
  it.effect("uses service", () =>
    Effect.gen(function* () {
      const svc = yield* MyService
      const result = yield* svc.doThing()
      expect(result).toBeDefined()
    })
  )
})
```

## Common Effect Operations Cheat Sheet

| Want to... | Use |
|------------|-----|
| Transform success value | `Effect.map(fn)` |
| Chain effects | `Effect.flatMap(fn)` |
| Run side effect | `Effect.tap(fn)` |
| Sequence (ignore first) | `Effect.andThen(effect)` |
| Map over array | `Effect.forEach(items, fn)` |
| Reduce with failure | `Effect.reduce(items, init, fn)` |
| Boolean branch | `Effect.if(cond, { onTrue, onFalse })` |
| Catch error | `Effect.catchTag("Tag", fn)` |
| Provide service | `Effect.provide(layer)` |
| Discard value | `Effect.asVoid` |
| Succeed with value | `Effect.succeed(value)` |
| Fail with error | `Effect.fail(error)` |
| From nullable | `Effect.fromNullable(value)` |
