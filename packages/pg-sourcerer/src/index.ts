/**
 * pg-sourcerer - PostgreSQL code generation framework
 * 
 * Main entry point
 */

// Config
export { Config, TypeHint, TypeHintMatch, type ResolvedConfig, type ConfigInput } from "./config.js"

// Config Loader Service
export {
  type ConfigLoader,
  ConfigLoaderService,
  ConfigLoaderLive,
  createConfigLoader,
  defineConfig,
} from "./services/config-loader.js"

// Config Service (Effect DI)
export {
  ConfigService,
  ConfigFromFile,
  ConfigWithInit,
  ConfigTest,
  getConfigSearchPaths,
} from "./services/config.js"

// Errors
export * from "./errors.js"

// IR
export {
  type SemanticIR,
  type SemanticIRBuilder,
  type Entity,
  type TableEntity,
  type EnumEntity,
  type DomainEntity,
  type DomainConstraint,
  type CompositeEntity,
  type Shape,
  type Field,
  type Relation,
  type ExtensionInfo,
  type Artifact,
  type CapabilityKey,
  type PrimaryKey,
  type EntityKind,
  type DomainBaseTypeInfo,
  type FunctionEntity,
  type FunctionArg,
  type Volatility,
  createIRBuilder,
  freezeIR,
  // Type guards
  isTableEntity,
  isEnumEntity,
  isDomainEntity,
  isCompositeEntity,
  isFunctionEntity,
  // Helpers
  getTableEntities,
  getEnumEntities,
  getDomainEntities,
  getCompositeEntities,
  getFunctionEntities,
  // Reverse relations
  type ReverseRelation,
  type AllRelations,
  getReverseRelations,
  getAllRelations,
} from "./ir/index.js"

export { SmartTags, ShapeKind } from "./ir/index.js"

// Services - IR
export { IR } from "./services/ir.js"

// Services - Artifact Store
export { ArtifactStore, type ArtifactStoreImpl, createArtifactStore, ArtifactStoreLive } from "./services/artifact-store.js"

// Services - Plugin Meta
export { PluginMeta, type PluginMetaInfo } from "./services/plugin-meta.js"

// Services - Plugin Types (Effect-native plugin interface)
export {
  type Plugin,
  type PluginFactory,
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
  type InflectionConfig,
  type TransformFn,
  Inflection,
  inflect,
  defaultInflection,
  defaultTransforms,
  createInflection,
  makeInflectionLayer,
  composeInflectionConfigs,
  composeInflection,
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
  type CompositeLookupResult,
  ExtensionTypeMap,
  defaultPgToTs,
  getExtensionTypeMapping,
  composeMappers,
  wrapArrayType,
  wrapNullable,
  findEnumByPgName,
  findCompositeByPgName,
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

// Conjure - AST builder DSL
export {
  conjure,
  cast,
  type ChainBuilder,
  type ObjBuilder,
  type ArrBuilder,
  type FnBuilder,
  type SymbolContext,
  type SymbolMeta,
  type SymbolStatement,
  type SymbolProgram,
} from "./lib/conjure.js"

// Hex - SQL query building primitives
export {
  hex,
  type SqlStyle,
  type QueryParts,
  buildTemplateLiteral,
  buildAwaitSqlTag,
  buildAwaitSqlString,
  buildQuery,
  buildFirstRowDecl,
  buildAllRowsDecl,
  buildReturnQuery,
} from "./lib/hex.js"

// Plugins
export { typesPlugin } from "./plugins/types.js"
export { zodPlugin } from "./plugins/zod.js"
export { valibotPlugin } from "./plugins/valibot.js"
export { arktypePlugin } from "./plugins/arktype.js"
export { effectModelPlugin } from "./plugins/effect-model.js"
export { sqlQueriesPlugin } from "./plugins/sql-queries.js"
export { kyselyQueriesPlugin } from "./plugins/kysely-queries.js"
export { kyselyTypesPlugin } from "./plugins/kysely-types.js"
export { httpElysiaPlugin } from "./plugins/http-elysia.js"
export { httpTrpcPlugin } from "./plugins/http-trpc.js"
export { httpOrpcPlugin } from "./plugins/http-orpc.js"

// Generate orchestration
export {
  generate,
  runGenerate,
  GenerateLive,
  type GenerateOptions,
  type GenerateResult,
  type GenerateError,
} from "./generate.js"

// Database introspection
export {
  type DatabaseIntrospection,
  type IntrospectOptions,
  DatabaseIntrospectionService,
  DatabaseIntrospectionLive,
  createDatabaseIntrospection,
  introspectDatabase,
} from "./services/introspection.js"
