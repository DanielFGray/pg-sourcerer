/**
 * Runtime Error Types
 *
 * All errors use Schema.TaggedError for:
 * - Serializable errors (can send over network/save to DB)
 * - Type-safe with built-in _tag for pattern matching
 * - Yieldable directly without Effect.fail()
 */
import { Schema } from "effect";

/**
 * Error thrown when a plugin's declare phase fails.
 */
export class DeclareError extends Schema.TaggedError<DeclareError>()("DeclareError", {
  message: Schema.String,
  plugin: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error thrown when a plugin's render phase fails.
 */
export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
  message: Schema.String,
  plugin: Schema.String,
  symbol: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
