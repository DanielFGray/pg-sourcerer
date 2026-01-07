/**
 * Plugin Types
 *
 * Defines the Effect-native plugin interface where plugins are Effects
 * that yield the services they need from context.
 */
import { Effect, Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import type { Artifact, CapabilityKey, SemanticIR, Entity } from "../ir/semantic-ir.js"
import { PluginExecutionFailed } from "../errors.js"
import type { CoreInflection, InflectionConfig } from "./inflection.js"
import type { SymbolRegistry } from "./symbols.js"
import type { TypeHintRegistry } from "./type-hints.js"
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
 * Context provided to fileName function for output file path generation.
 * 
 * This gives plugins full programmatic control over file naming,
 * with access to entity info and inflection utilities.
 */
export interface FileNameContext {
  /** Already-inflected entity name */
  readonly entityName: string
  /** Raw PostgreSQL table/view name */
  readonly tableName: string
  /** Schema name */
  readonly schema: string
  /** Inflection utilities (singularize, pluralize, etc.) */
  readonly inflection: CoreInflection
  /** Full entity from IR for advanced use cases */
  readonly entity: Entity
}

/**
 * Plugin-specific inflection for output file and symbol naming
 */
export interface PluginInflection {
  /**
   * Generate output file path for an entity.
   * 
   * @param ctx - Context with entity info and inflection utilities
   * @returns File path relative to outputDir (include extension)
   * 
   * @example
   * ```typescript
   * // Default: entity name as file
   * fileName: (ctx) => `${ctx.entityName}.ts`
   * 
   * // Lowercase files
   * fileName: (ctx) => `${ctx.entityName.toLowerCase()}.ts`
   * 
   * // Singular lowercase
   * fileName: (ctx) => `${ctx.inflection.singularize(ctx.entityName).toLowerCase()}.ts`
   * 
   * // Schema-scoped
   * fileName: (ctx) => `${ctx.schema}/${ctx.entityName}.ts`
   * 
   * // Single file for all entities
   * fileName: () => `all-models.ts`
   * ```
   */
  readonly outputFile: (ctx: FileNameContext) => string
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
   * Plugin's default inflection transforms.
   * 
   * These are applied BEFORE user-configured inflection, allowing composition:
   * - Plugin sets baseline (e.g., entityName: inflect.pascalCase → "users" → "Users")
   * - User config refines (e.g., entityName: inflect.singularize → "Users" → "User")
   * 
   * @example
   * ```typescript
   * import { inflect } from "pg-sourcerer"
   * 
   * inflectionDefaults: {
   *   entityName: inflect.pascalCase,  // Plugin wants PascalCase class names
   *   // fieldName not set = plugin preserves field names as-is
   * }
   * ```
   */
  readonly inflectionDefaults?: InflectionConfig

  /**
   * Plugin execution - returns Effect that yields services from context.
   *
   * Services available:
   * - IR: SemanticIR (read-only)
   * - Inflection: CoreInflection (composed: plugin defaults + user config)
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
 * A plugin factory function that creates ConfiguredPlugin instances.
 * 
 * The factory also exposes the underlying plugin for inspection:
 * - `factory.plugin` - The Plugin object with name, provides, requires, etc.
 */
export interface PluginFactory<TConfig> {
  (config: TConfig): ConfiguredPlugin
  /** The underlying plugin definition */
  readonly plugin: Plugin<TConfig>
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

  /** Plugin's inflection for file and symbol naming */
  readonly pluginInflection: PluginInflection

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

  /** Plugin-specific inflection for file and symbol naming */
  readonly inflection: PluginInflection

  /**
   * Plugin's default inflection transforms.
   * 
   * These are applied BEFORE user-configured inflection, allowing composition:
   * - Plugin sets baseline (e.g., entityName: inflect.pascalCase → "users" → "Users")
   * - User config refines (e.g., entityName: inflect.singularize → "Users" → "User")
   */
  readonly inflectionDefaults?: InflectionConfig

  /**
   * Plugin execution function.
   * Can be sync or async (return void or Promise<void>).
   */
  readonly run: (ctx: SimplePluginContext, config: TConfig) => void | Promise<void>
}

/**
 * Create a plugin factory from a simple function-based definition.
 *
 * Returns a curried function that accepts config and returns a ConfiguredPlugin.
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
 *
 * // Usage in config:
 * plugins: [
 *   myPlugin({ outputDir: "types" }),
 * ]
 * ```
 */
export function definePlugin<TConfig>(def: SimplePluginDef<TConfig>): PluginFactory<TConfig> {
  // Build the internal plugin object
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
          pluginInflection: def.inflection,

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

  // Add optional properties only if defined (exactOptionalPropertyTypes)
  let finalPlugin: Plugin<TConfig> = plugin
  if (def.requires !== undefined) {
    finalPlugin = { ...finalPlugin, requires: def.requires }
  }
  if (def.inflectionDefaults !== undefined) {
    finalPlugin = { ...finalPlugin, inflectionDefaults: def.inflectionDefaults }
  }

  // Return the curried factory function with plugin attached for inspection
  return Object.assign(
    (config: TConfig): ConfiguredPlugin => ({
      plugin: finalPlugin as Plugin<unknown>,
      config,
    }),
    { plugin: finalPlugin }
  )
}
