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
export const validateConsumes = (plugins: readonly Plugin[]) =>
  Effect.gen(function* () {
    const provided = new Set<Capability>(plugins.flatMap(plugin => plugin.provides));
    yield* Effect.forEach(plugins, plugin =>
      Effect.forEach(plugin.consumes ?? [], cap => {
        if (!provided.has(cap)) {
          return Effect.fail(
            new UnsatisfiedCapability({
              message: `Plugin "${plugin.name}" consumes "${cap}" but no plugin provides it`,
              capability: cap,
              consumer: plugin.name,
            }),
          );
        }
        return Effect.succeed(undefined);
      }),
    );
  });

/**
 * Validate that symbol dependencies form a DAG (no cycles).
 */
export const validateDependencyGraph = (declarations: readonly SymbolDeclaration[]) =>
  Effect.gen(function* () {
    const adjacency = new Map<Capability, Capability[]>();
    for (const decl of declarations) {
      adjacency.set(decl.capability, [...(decl.dependsOn ?? [])]);
    }

    const visited = new Set<Capability>();
    const recursionStack = new Set<Capability>();

    const detectCycle = (cap: Capability, path: Capability[]): Effect.Effect<void, CircularDependency> =>
      Effect.suspend(() => {
        if (recursionStack.has(cap)) {
          const cycleStart = path.indexOf(cap);
          const cycle = [...path.slice(cycleStart), cap];
          return Effect.fail(
            new CircularDependency({
              message: `Circular dependency detected: ${cycle.join(" -> ")}`,
              cycle,
            }),
          );
        }

        if (visited.has(cap)) {
          return Effect.void;
        }

        visited.add(cap);
        recursionStack.add(cap);

        const deps = adjacency.get(cap) ?? [];
        return Effect.forEach(deps, dep => detectCycle(dep, [...path, cap]), { discard: true }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              recursionStack.delete(cap);
            }),
          ),
        );
      });

    yield* Effect.forEach(Array.from(adjacency.keys()), cap => detectCycle(cap, []));
  });

/**
 * Run all validations on plugins and their declarations.
 */
export const validateAll = (
  plugins: readonly Plugin[],
  registry: { all(): readonly SymbolDeclaration[] },
) => Effect.all([validateConsumes(plugins), validateDependencyGraph(registry.all())]);
