import { Effect, Schema } from "effect";
import type { Plugin, SymbolDeclaration, Capability } from "./types.js";

/**
 * Error when a plugin consumes a capability that no plugin provides.
 */
export class UnsatisfiedCapability extends Schema.TaggedError<UnsatisfiedCapability>()(
  "UnsatisfiedCapability",
  {
    message: Schema.String,
    capability: Schema.String,
    consumer: Schema.String,
  },
) {}

/**
 * Error when there's a circular dependency between symbols.
 */
export class CircularDependency extends Schema.TaggedError<CircularDependency>()(
  "CircularDependency",
  {
    message: Schema.String,
    cycle: Schema.Array(Schema.String),
  },
) {}

/**
 * Validate that all plugin.consumes are satisfied by some plugin.provides.
 */
export function validateConsumes(
  plugins: readonly Plugin[],
): Effect.Effect<void, UnsatisfiedCapability> {
  return Effect.gen(function* () {
    const provided = new Set<Capability>();
    for (const plugin of plugins) {
      for (const cap of plugin.provides) {
        provided.add(cap);
      }
    }

    for (const plugin of plugins) {
      for (const cap of plugin.consumes ?? []) {
        if (!provided.has(cap)) {
          yield* new UnsatisfiedCapability({
            message: `Plugin "${plugin.name}" consumes "${cap}" but no plugin provides it`,
            capability: cap,
            consumer: plugin.name,
          });
        }
      }
    }
  });
}

/**
 * Validate that symbol dependencies form a DAG (no cycles).
 */
export function validateDependencyGraph(
  declarations: readonly SymbolDeclaration[],
): Effect.Effect<void, CircularDependency> {
  return Effect.gen(function* () {
    const adjacency = new Map<Capability, Capability[]>();
    for (const decl of declarations) {
      adjacency.set(decl.capability, [...(decl.dependsOn ?? [])]);
    }

    const visited = new Set<Capability>();
    const recursionStack = new Set<Capability>();

    const detectCycle = (
      cap: Capability,
      path: Capability[],
    ): Effect.Effect<void, CircularDependency> =>
      Effect.gen(function* () {
        if (recursionStack.has(cap)) {
          const cycleStart = path.indexOf(cap);
          const cycle = [...path.slice(cycleStart), cap];
          yield* new CircularDependency({
            message: `Circular dependency detected: ${cycle.join(" -> ")}`,
            cycle,
          });
        }

        if (visited.has(cap)) {
          return;
        }

        visited.add(cap);
        recursionStack.add(cap);

        const deps = adjacency.get(cap) ?? [];
        yield* Effect.forEach(deps, dep => detectCycle(dep, [...path, cap]));

        recursionStack.delete(cap);
      });

    yield* Effect.forEach(Array.from(adjacency.keys()), cap => detectCycle(cap, []));
  });
}

/**
 * Run all validations on plugins and their declarations.
 */
export function validateAll(
  plugins: readonly Plugin[],
  registry: { all(): readonly SymbolDeclaration[] },
): Effect.Effect<void, UnsatisfiedCapability | CircularDependency> {
  return Effect.gen(function* () {
    yield* validateConsumes(plugins);
    yield* validateDependencyGraph(registry.all());
  });
}
