/**
 * Plugin Types
 *
 * Defines the Effect-native plugin interface where plugins are Effects
 * that yield the services they need from context.
 */
import { Effect, Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import type { Artifact, CapabilityKey, SemanticIR } from "../ir/semantic-ir.js"
import { PluginExecutionFailed } from "../errors.js"
import type { CoreInflection } from "./inflection.js"
import type { EmissionBuffer } from "./emissions.js"
import type { SymbolRegistry } from "./symbols.js"
import type { TypeHintRegistry } from "./type-hints.js"
import type { ImportCollector } from "./imports.js"
import type { ArtifactStoreImpl } from "./artifact-store.js"
import type { PluginMetaInfo } from "./plugin-meta.js"
import type { FileBuilder } from "./file-builder.js"
import { createFileBuilder } from "./file-builder.js"

// Import service tags for yielding in definePlugin
import { IR } from "./ir.js"
import { ArtifactStore } from "./artifact-store.js"
import { PluginMeta } from "./plugin-meta.js"
import { Inflection } from "./inflection.js"
import { Emissions } from "./emissions.js"
import { Symbols } from "./symbols.js"
import { TypeHints } from "./type-hints.js"

/**
 * Plugin-specific inflection for output file and symbol naming
 */
export interface PluginInflection {
  readonly outputFile: (entityName: string, artifactKind: string) => string
  readonly symbolName: (entityName: string, artifactKind: string) => string
}

/**
 * Union of all service tags available to plugins.
 *
 * Plugins can yield any of these from Effect context:
 * ```typescript
 * const ir = yield* IR
 * const inflection = yield* Inflection
 * ```
 */
export type PluginServices = IR | Inflection | Emissions | Symbols | TypeHints | ArtifactStore | PluginMeta

/**
 * Effect-native Plugin interface
 *
 * Plugins are Effects that yield the services they need from context.
 * The PluginRunner provides all services via layers.
 *
 * @example
 * ```typescript
 * const myPlugin: Plugin<MyConfig> = {
 *   name: "my-plugin",
 *   provides: ["types:row"],
 *   configSchema: MyConfigSchema,
 *   inflection: { ... },
 *
 *   run: (config) => Effect.gen(function* () {
 *     const ir = yield* IR
 *     const emissions = yield* Emissions
 *     const meta = yield* PluginMeta
 *
 *     for (const entity of ir.entities.values()) {
 *       emissions.emit(`types/${entity.name}.ts`, generateType(entity), meta.name)
 *     }
 *   })
 * }
 * ```
 */
export interface Plugin<TConfig = unknown> {
  /** Unique plugin name */
  readonly name: string

  /** Capabilities this plugin requires (must be provided by earlier plugins) */
  readonly requires?: readonly CapabilityKey[]

  /** Capabilities this plugin provides */
  readonly provides: readonly CapabilityKey[]

  /** Configuration schema (Effect Schema) - Schema<TConfig> or Schema<TConfig, Encoded> */
  readonly configSchema: S.Schema<TConfig>

  /** Plugin-specific inflection for file and symbol naming */
  readonly inflection: PluginInflection

  /**
   * Plugin execution - returns Effect that yields services from context.
   *
   * Services available:
   * - IR: SemanticIR (read-only)
   * - Inflection: CoreInflection
   * - Emissions: EmissionBuffer
   * - Symbols: SymbolRegistry
   * - TypeHints: TypeHintRegistry
   * - ArtifactStore: plugin-to-plugin data
   * - PluginMeta: current plugin name
   */
  readonly run: (config: TConfig) => Effect.Effect<
    void,
    PluginExecutionFailed,
    // Service requirements via Context.Tag types
    IR | Inflection | Emissions | Symbols | TypeHints | ArtifactStore | PluginMeta
  >
}

/**
 * A plugin with its validated configuration
 */
export interface ConfiguredPlugin {
  readonly plugin: Plugin<unknown>
  readonly config: unknown
}

// ============================================================================
// Simple Plugin API
// ============================================================================

/**
 * Logger interface for simple plugins
 */
export interface SimplePluginLogger {
  readonly debug: (message: string) => void
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
}

/**
 * Context object provided to simple plugins.
 *
 * This is a convenience wrapper around the Effect services,
 * providing a plain object API for plugins that don't need
 * full Effect capabilities.
 */
export interface SimplePluginContext {
  /** Read-only access to the IR */
  readonly ir: SemanticIR

  /** Core inflection service */
  readonly inflection: CoreInflection

  /** Symbol registry for cross-file imports */
  readonly symbols: SymbolRegistry

  /** Type hints registry */
  readonly typeHints: TypeHintRegistry

  /** Emit string content to a file (buffered) */
  readonly emit: (path: string, content: string) => void

  /**
   * Emit an AST program to a file (buffered).
   * The plugin runner handles serialization after all plugins run.
   * 
   * @param path - Output file path
   * @param ast - The AST program node to emit
   * @param header - Optional header to prepend (e.g., imports that can't be in AST)
   */
  readonly emitAst: (path: string, ast: n.Program, header?: string) => void

  /** Append to an already-emitted file */
  readonly appendEmit: (path: string, content: string) => void

  /** Get an artifact from a previous plugin */
  readonly getArtifact: (capability: CapabilityKey) => Artifact | undefined

  /** Store an artifact for downstream plugins */
  readonly setArtifact: (capability: CapabilityKey, data: unknown) => void

  /** Logging */
  readonly log: SimplePluginLogger

  /** Current plugin name */
  readonly pluginName: string

  /**
   * Create a FileBuilder for structured file emission.
   * 
   * Use this for AST-based code generation with automatic symbol registration:
   * 
   * @example
   * ```typescript
   * ctx.file("types/User.ts")
   *   .header("// Auto-generated")
   *   .import({ kind: "package", names: ["z"], from: "zod" })
   *   .ast(symbolProgram(...))
   *   .emit()
   * ```
   */
  readonly file: (path: string) => FileBuilder
}

/**
 * Definition for a simple plugin (no Effect knowledge required)
 */
export interface SimplePluginDef<TConfig = unknown> {
  /** Unique plugin name */
  readonly name: string

  /** Capabilities this plugin requires */
  readonly requires?: readonly CapabilityKey[]

  /** Capabilities this plugin provides */
  readonly provides: readonly CapabilityKey[]

  /** Configuration schema */
  readonly configSchema: S.Schema<TConfig>

  /** Plugin-specific inflection */
  readonly inflection: PluginInflection

  /**
   * Plugin execution function.
   * Can be sync or async (return void or Promise<void>).
   */
  readonly run: (ctx: SimplePluginContext, config: TConfig) => void | Promise<void>
}

/**
 * Create an Effect-native plugin from a simple function-based definition.
 *
 * This helper allows writing plugins without Effect knowledge:
 *
 * @example
 * ```typescript
 * const myPlugin = definePlugin({
 *   name: "my-plugin",
 *   provides: ["types:row"],
 *   configSchema: S.Struct({ outputDir: S.String }),
 *   inflection: { ... },
 *
 *   run: (ctx, config) => {
 *     for (const entity of ctx.ir.entities.values()) {
 *       ctx.emit(`${config.outputDir}/${entity.name}.ts`, generateType(entity))
 *     }
 *   }
 * })
 * ```
 *
 * Async plugins are also supported:
 * ```typescript
 * const asyncPlugin = definePlugin({
 *   ...
 *   run: async (ctx, config) => {
 *     const data = await fetchExternalSchema()
 *     ctx.emit("schema.ts", generateFromData(data))
 *   }
 * })
 * ```
 */
export function definePlugin<TConfig>(def: SimplePluginDef<TConfig>): Plugin<TConfig> {
  // Build the plugin object, conditionally including requires
  const plugin: Plugin<TConfig> = {
    name: def.name,
    provides: def.provides,
    configSchema: def.configSchema,
    inflection: def.inflection,

    run: (config: TConfig) =>
      Effect.gen(function* () {
        // Yield all services from context
        const ir = yield* IR
        const inflection = yield* Inflection
        const emissions = yield* Emissions
        const symbols = yield* Symbols
        const typeHints = yield* TypeHints
        const artifactStore = yield* ArtifactStore
        const meta = yield* PluginMeta

        // Build the simple context object
        const ctx: SimplePluginContext = {
          ir,
          inflection,
          symbols,
          typeHints,
          pluginName: meta.name,

          emit: (path, content) => {
            emissions.emit(path, content, meta.name)
          },

          emitAst: (path, ast, header) => {
            emissions.emitAst(path, ast, meta.name, header)
          },

          appendEmit: (path, content) => {
            emissions.appendEmit(path, content, meta.name)
          },

          getArtifact: (capability) => artifactStore.get(capability),

          setArtifact: (capability, data) => {
            artifactStore.set(capability, meta.name, data)
          },

          file: (path) => createFileBuilder(path, meta.name, emissions, symbols),

          log: {
            // Use Effect logging with plugin name annotation
            // These run synchronously since logging is side-effect only
            debug: (message) => {
              Effect.runSync(
                Effect.logDebug(message).pipe(
                  Effect.annotateLogs("plugin", meta.name)
                )
              )
            },
            info: (message) => {
              Effect.runSync(
                Effect.logInfo(message).pipe(
                  Effect.annotateLogs("plugin", meta.name)
                )
              )
            },
            warn: (message) => {
              Effect.runSync(
                Effect.logWarning(message).pipe(
                  Effect.annotateLogs("plugin", meta.name)
                )
              )
            },
          },
        }

        // Call the user's run function, handling sync/async errors
        const result = yield* Effect.try({
          try: () => def.run(ctx, config),
          catch: (error) =>
            new PluginExecutionFailed({
              message: `Plugin ${def.name} failed`,
              plugin: def.name,
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
        })

        // If it returned a promise, await it
        if (result instanceof Promise) {
          yield* Effect.tryPromise({
            try: () => result,
            catch: (error) =>
              new PluginExecutionFailed({
                message: `Plugin ${def.name} failed`,
                plugin: def.name,
                cause: error instanceof Error ? error : new Error(String(error)),
              }),
          })
        }
      }),
  }

  // Add requires only if defined (exactOptionalPropertyTypes)
  if (def.requires !== undefined) {
    return { ...plugin, requires: def.requires }
  }

  return plugin
}
