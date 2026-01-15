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

// Services - File Writer
export {
  type FileWriter,
  type WriteResult,
  type WriteOptions,
  FileWriterSvc,
  createFileWriter,
  FileWriterLive,
} from "./services/file-writer.js";

// Services - Smart Tags Parser
export {
  type ParsedComment,
  type TagContext,
  parseSmartTags,
} from "./services/smart-tags-parser.js";

// Services - IR Builder
export {
  type IRBuilder,
  type IRBuilderOptions,
  IRBuilderSvc,
  IRBuilderLive,
  createIRBuilderService,
} from "./services/ir-builder.js";

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
} from "./conjure/index.js";

// Hex - SQL query building primitives
export {
  hex,
  // Query object (primary plugin interface)
  Query,
  createQuery,
  type TemplateParts,
  type TaggedTemplateOptions,
  type ParameterizedCallOptions,
  // Query specs
  type QueryParts,
  type SelectSpec,
  type SelectItem,
  type FromItem,
  type JoinItem,
  type WhereCondition,
  type OrderByItem,
  type GroupByItem,
  type MutationSpec,
  type ParamSpec,
  type Expression,
  // Legacy/raw builders
  toQueryDescriptor,
  buildReturnDescriptor,
  buildParamDescriptor,
  buildFieldDescriptor,
} from "./hex/index.js";

// Database introspection
export {
  type DatabaseIntrospection,
  type IntrospectOptions,
  DatabaseIntrospectionService,
  DatabaseIntrospectionLive,
  createDatabaseIntrospection,
  introspectDatabase,
} from "./services/introspection.js";

// =============================================================================
// Runtime - New Plugin System
// =============================================================================

// Runtime Types
export {
  type Plugin,
  type Capability,
  type SymbolDeclaration,
  type SymbolRef,
  type SymbolHandle,
  type RenderedSymbol,
  type DeclareServices,
  type RenderServices,
} from "./runtime/types.js";

// Runtime Errors
export { DeclareError, RenderError } from "./runtime/errors.js";

// Runtime Registry
export {
  SymbolRegistry,
  SymbolRegistryImpl,
  SymbolCollision,
  CapabilityNotFound,
  createSymbolHandle,
} from "./runtime/registry.js";

// Runtime Orchestrator
export {
  runPlugins,
  type OrchestratorConfig,
  type OrchestratorResult,
  type PluginExecutionError,
} from "./runtime/orchestrator.js";

// Runtime Validation
export {
  validateAll,
  validateConsumes,
  validateDependencyGraph,
  UnsatisfiedCapability,
  CircularDependency,
} from "./runtime/validation.js";

// Runtime File Assignment
export {
  assignSymbolsToFiles,
  groupByFile,
  type FileAssignmentConfig,
  type FileRule,
  type AssignedSymbol,
} from "./runtime/file-assignment.js";

// Runtime Emit
export {
  emitFiles,
  type EmittedFile,
  type EmitConfig,
  type ExternalImport,
  type RenderedSymbolWithImports,
} from "./runtime/emit.js";

// =============================================================================
// Plugins
// =============================================================================

export { typesPlugin } from "./plugins/types.js";

// =============================================================================
// Testing Utilities
// =============================================================================

export {
  testIR,
  testIRWithEntities,
  testConfig,
  testPlugin,
  testPluginEmit,
  defaultTestFileRules,
  type TestPluginOptions,
} from "./testing.js";
