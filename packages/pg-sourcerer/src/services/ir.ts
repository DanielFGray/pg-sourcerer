/**
 * IR Service
 *
 * Provides read-only access to the SemanticIR for plugins.
 * This is a simple value service - the IR is built once per run
 * and provided to all plugins.
 */
import { Context } from "effect";
import type { SemanticIR } from "../ir/semantic-ir.js";

/**
 * IR service tag - provides SemanticIR to plugins
 *
 * Usage in plugins:
 * ```typescript
 * const ir = yield* IR
 * for (const entity of ir.entities.values()) { ... }
 * ```
 *
 * Layer is created per-run by PluginRunner:
 * ```typescript
 * const irLayer = Layer.succeed(IR, builtIR)
 * ```
 */
export class IR extends Context.Tag("IR")<IR, SemanticIR>() {}
