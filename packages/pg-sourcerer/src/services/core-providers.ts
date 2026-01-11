/**
 * Core Providers
 *
 * Built-in providers that other providers depend on.
 */
import { definePlugin, type Plugin } from "./plugin.js"
import type { SemanticIR } from "../ir/semantic-ir.js"

/**
 * Semantic IR Provider
 *
 * Singleton provider that supplies the built IR to other providers.
 * The IR is passed in at construction time (built by generate.ts).
 */
export function createSemanticIRProvider(ir: SemanticIR): Plugin<Record<string, never>, SemanticIR> {
  return definePlugin({
    name: "semantic-ir",
    kind: "semantic-ir",
    singleton: true,
    singletonParams: {},

    canProvide: () => true,

    provide: () => ir,
  })
}
