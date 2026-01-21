/**
 * pg-sourcerer - PostgreSQL code generation framework
 *
 * Main entry point
 */

// Config
export {
  Config,
  TypeHint,
  TypeHintMatch,
  type ResolvedConfig,
  type ConfigInput,
} from "./config.js";

// Config Loader Service
export {
  type ConfigLoader,
  ConfigLoaderService,
  ConfigLoaderLive,
  createConfigLoader,
  defineConfig,
} from "./services/config-loader.js";

// Config Service (Effect DI)
export {
  // Service tag
  ConfigService,
  // Provider interface and implementations
  type ConfigProvider,
  FileConfigProvider,
  InMemoryConfigProvider,
  withFallback,
  // Layer constructors
  ConfigFromFile,
  ConfigFromMemory,
  ConfigTest,
  ConfigWithFallback,
  // Utilities
  getConfigSearchPaths,
} from "./services/config.js";

// Errors
export * from "./errors.js";

// User Module References
export { userModule, isUserModuleRef, type UserModuleRef, type UserModuleOptions } from "./user-module.js";

// User Module Parser Service
export {
  type UserModuleParser,
  type UserModuleExports,
  UserModuleParserService,
  UserModuleParserLive,
  createUserModuleParser,
} from "./services/user-module-parser.js";

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
} from "./ir/index.js";

export { SmartTags, ShapeKind } from "./ir/index.js";

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
} from "./ir/extensions/queries.js";

// IR Extensions - Schema Builder Contract
export {
  type SchemaImportSpec,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
  type SchemaBuilder,
  SCHEMA_BUILDER_KIND,
} from "./ir/extensions/schema-builder.js";

// Services - IR
export { IR } from "./services/ir.js";

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
} from "./services/inflection.js";

// Services - Type Hints
export {
  type TypeHintRegistry,
  type TypeHintFieldMatch,
  TypeHints,
  createTypeHintRegistry,
  emptyTypeHintRegistry,
  TypeHintsLive,
} from "./services/type-hints.js";

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
} from "./services/pg-types.js";

// Services - File Assignment
export {
  type FileNaming,
  type FileNamingContext,
  type AssignedSymbol,
  parseCapabilityInfo,
} from "./runtime/file-assignment.js";

// Runtime Emit
export {
  emitFiles,
  type EmittedFile,
  type EmitConfig,
  type ExternalImport,
  type RenderedSymbolWithImports,
} from "./runtime/emit.js";

// Plugin Types (for custom plugin authors)
export type {
  Plugin,
  Capability,
  SymbolDeclaration,
  SymbolRef,
  RenderedSymbol,
  SymbolHandle,
} from "./runtime/types.js";

// =============================================================================
// Plugins
// =============================================================================

export { typesPlugin } from "./plugins/types.js";
export { zod, type ZodConfig } from "./plugins/zod.js";
export { arktype, type ArkTypeConfig } from "./plugins/arktype.js";
export { valibot, type ValibotConfig } from "./plugins/valibot.js";
export { effect, type EffectConfig } from "./plugins/effect/index.js";
export { express, type HttpExpressConfig } from "./plugins/http-express.js";
export { elysia, type HttpElysiaConfig } from "./plugins/http-elysia.js";
export { hono, type HttpHonoConfig } from "./plugins/http-hono.js";
export { kysely, type KyselyConfig } from "./plugins/kysely.js";
export { sqlQueries, type SqlQueriesConfig } from "./plugins/sql-queries.js";
export { orpc, type HttpOrpcConfig } from "./plugins/http-orpc.js";
export { trpc, type HttpTrpcConfig } from "./plugins/http-trpc.js";

// =============================================================================
// Testing Utilities
// =============================================================================

export {
  testIR,
  testIRWithEntities,
  testIRFromFixture,
  testConfig,
  testPlugin,
  testPluginEmit,
  type TestPluginOptions,
} from "./testing.js";
