/**
 * pg-sourcerer - PostgreSQL code generation framework
 * 
 * Main entry point
 */

// Config
export { Config, TypeHint, TypeHintMatch, type ResolvedConfig } from "./config.js"

// Config Loader Service
export {
  type ConfigLoader,
  ConfigLoaderService,
  ConfigLoaderLive,
  createConfigLoader,
  defineConfig,
} from "./services/config-loader.js"

// Errors
export * from "./errors.js"

// IR
export {
  type SemanticIR,
  type SemanticIRBuilder,
  type Entity,
  type Shape,
  type Field,
  type Relation,
  type EnumDef,
  type ExtensionInfo,
  type Artifact,
  type CapabilityKey,
  type PrimaryKey,
  createIRBuilder,
  freezeIR,
} from "./ir/index.js"

export { SmartTags, ShapeKind, emptySmartTags } from "./ir/index.js"

// Services - IR
export { IR } from "./services/ir.js"

// Services - Artifact Store
export { ArtifactStore, type ArtifactStoreImpl, createArtifactStore, ArtifactStoreLive } from "./services/artifact-store.js"

// Services - Plugin Meta
export { PluginMeta, type PluginMetaInfo } from "./services/plugin-meta.js"

// Services - Plugin Types (Effect-native plugin interface)
export {
  type Plugin,
  type PluginInflection,
  type PluginServices,
  type ConfiguredPlugin,
  // Simple plugin API
  type SimplePluginContext,
  type SimplePluginDef,
  type SimplePluginLogger,
  definePlugin,
} from "./services/plugin.js"

// Services - Inflection
export {
  type CoreInflection,
  Inflection,
  liveInflection,
  InflectionLive,
} from "./services/inflection.js"

// Services - Type Hints
export {
  type TypeHintRegistry,
  type TypeHintFieldMatch,
  TypeHints,
  createTypeHintRegistry,
  emptyTypeHintRegistry,
  TypeHintsLive,
} from "./services/type-hints.js"

// Services - PostgreSQL Type Mapping
export {
  PgTypeOid,
  TsType,
  type TypeMappingResult,
  type TypeMapper,
  type EnumLookupResult,
  ExtensionTypeMap,
  defaultPgToTs,
  getExtensionTypeMapping,
  composeMappers,
  wrapArrayType,
  wrapNullable,
  findEnumByPgName,
} from "./services/pg-types.js"

// Services - Symbols
export {
  type SymbolRegistry,
  type Symbol,
  type SymbolRef,
  type ImportStatement,
  type SymbolCollision,
  Symbols,
  createSymbolRegistry,
  SymbolsLive,
} from "./services/symbols.js"

// Services - Emissions
export {
  type EmissionBuffer,
  type EmissionEntry,
  Emissions,
  createEmissionBuffer,
  EmissionsLive,
} from "./services/emissions.js"

// Services - Plugin Runner
export { PluginRunner } from "./services/plugin-runner.js"

// Services - File Writer
export {
  type FileWriter,
  type WriteResult,
  type WriteOptions,
  FileWriterSvc,
  createFileWriter,
  defaultHeader,
  FileWriterLive,
} from "./services/file-writer.js"

// Services - Smart Tags Parser
export {
  type ParsedComment,
  type TagContext,
  parseSmartTags,
} from "./services/smart-tags-parser.js"

// Services - IR Builder
export {
  type IRBuilder,
  type IRBuilderOptions,
  IRBuilderSvc,
  IRBuilderLive,
  createIRBuilderService,
} from "./services/ir-builder.js"

// Testing utilities
export {
  PluginTestLayers,
  createPluginTestLayer,
} from "./testing.js"

// Plugins
export { typesPlugin } from "./plugins/types.js"
export { zodPlugin } from "./plugins/zod.js"
