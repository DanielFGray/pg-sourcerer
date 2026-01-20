/**
 * Core error types for pg-sourcerer
 * Using Effect's Schema.TaggedError for typed error handling
 */
import { Schema } from "effect";

export class ConfigNotFound extends Schema.TaggedError<ConfigNotFound>()(
  "ConfigNotFound",
  {
    message: Schema.String,
    searchPaths: Schema.Array(Schema.String),
  }
) {}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  "ConfigInvalid",
  {
    message: Schema.String,
    path: Schema.String,
    errors: Schema.Array(Schema.String),
  }
) {}

export class ConnectionFailed extends Schema.TaggedError<ConnectionFailed>()(
  "ConnectionFailed",
  {
    message: Schema.String,
    connectionString: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

export class IntrospectionFailed extends Schema.TaggedError<IntrospectionFailed>()(
  "IntrospectionFailed",
  {
    message: Schema.String,
    schema: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

export class TagParseError extends Schema.TaggedError<TagParseError>()(
  "TagParseError",
  {
    message: Schema.String,
    objectType: Schema.Union(Schema.Literal("table"), Schema.Literal("column"), Schema.Literal("constraint"), Schema.Literal("type")),
    objectName: Schema.String,
    comment: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

export class WriteError extends Schema.TaggedError<WriteError>()(
  "WriteError",
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

export class ExportCollisionError extends Schema.TaggedError<ExportCollisionError>()(
  "ExportCollisionError",
  {
    file: Schema.String,
    exportName: Schema.String,
    exportKind: Schema.String,
    capability1: Schema.String,
    capability2: Schema.String,
    message: Schema.String,
  }
) {}

// =============================================================================
// User Module Errors
// =============================================================================

/**
 * Error when parsing a user module file fails.
 */
export class UserModuleParseError extends Schema.TaggedError<UserModuleParseError>()(
  "UserModuleParseError",
  {
    message: Schema.String,
    /** Absolute path to the file that failed to parse */
    path: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * Error when a requested export is not found in a user module.
 */
export class ExportNotFoundError extends Schema.TaggedError<ExportNotFoundError>()(
  "ExportNotFoundError",
  {
    message: Schema.String,
    /** Absolute path to the module */
    modulePath: Schema.String,
    /** The export name that was not found */
    exportName: Schema.String,
    /** Available exports in the module */
    availableExports: Schema.Array(Schema.String),
  }
) {}

/**
 * Error when a user module file is not found.
 */
export class UserModuleNotFoundError extends Schema.TaggedError<UserModuleNotFoundError>()(
  "UserModuleNotFoundError",
  {
    message: Schema.String,
    /** Path as specified in config (relative to config file) */
    configPath: Schema.String,
    /** Resolved absolute path that was checked */
    resolvedPath: Schema.String,
  }
) {}
