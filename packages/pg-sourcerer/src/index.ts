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

// IR Extensions - Contracts between providers
export {
  type ParamSource,
  type QueryMethodKind,
  type QueryMethodParam,
  type QueryMethodReturn,
  type CallSignature,
  type QueryMethod,
  type EntityQueriesExtension,
  type StandaloneFunction,
  type FunctionsExtension,
  EntityQueriesExtension as EntityQueriesExtensionSchema,
  FunctionsExtension as FunctionsExtensionSchema,
} from "./ir/extensions/queries.js"

// Services - IR
export { IR } from "./services/ir.js"

// Services - Artifact Store
export { ArtifactStore, type ArtifactStoreImpl, createArtifactStore, ArtifactStoreLive } from "./services/artifact-store.js"

// Services - Plugin Meta
export { PluginMeta, type PluginMetaInfo } from "./services/plugin-meta.js"

// Services - Plugin Types (new plugin API)
export {
  type Plugin,
  type PluginContext,
  type PluginRegistry,
  type PluginError,
  type ResourceRequest,
  type DeferredResource,
  PluginNotFound,
  PluginCycle,
  PluginExecutionFailed,
  ResourceNotResolved,
  Plugins,
  PluginsLive,
  definePlugin,
  createPluginRegistry,
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
  type MethodSymbol,
  type EntityMethods,
  Symbols,
  createSymbolRegistry,
  SymbolsLive,
} from "./services/symbols.js"

// Services - Service Registry (plugin-to-plugin communication)
export {
  type ServiceRegistry,
  Services,
  createServiceRegistry,
  ServicesLive,
} from "./services/service-registry.js"

// Services - Emissions
export {
  type EmissionBuffer,
  type EmissionEntry,
  Emissions,
  createEmissionBuffer,
  EmissionsLive,
} from "./services/emissions.js"

// Services - Plugin Runner
export {
  runPlugins,
  type PluginRunContext,
  type PluginRunResult,
  type PluginRunError,
} from "./services/plugin-runner.js"

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

// Plugins (new API)
export { typesPlugin, types } from "./plugins/types.js"
export { zod, type ZodConfig } from "./plugins/zod.js"
export { arktype, type ArkTypeConfig } from "./plugins/arktype.js"
export { valibot, type ValibotConfig } from "./plugins/valibot.js"
export { sqlQueries, sqlQueries as sqlQueriesPlugin, type SqlQueriesConfig } from "./plugins/sql-queries.js"

// Effect plugin (unified model + repository + http)
export { effect, effectPlugin, type EffectConfig } from "./plugins/effect.js"

// Kysely plugin
export { kysely, type KyselyConfig } from "./plugins/kysely.js"

// HTTP plugins (new API)
export { httpElysia, type HttpElysiaConfig } from "./plugins/http-elysia.js"
export { httpExpress, type HttpExpressConfig } from "./plugins/http-express.js"
export { httpHono, type HttpHonoConfig } from "./plugins/http-hono.js"
export { httpTrpc, type HttpTrpcConfig } from "./plugins/http-trpc.js"
export { httpOrpc, type HttpOrpcConfig } from "./plugins/http-orpc.js"

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
