/**
 * Core error types for pg-sourcerer
 * Using Effect's Data.TaggedEnum for typed error handling
 */
import { Data } from "effect"

// Base error type with common fields
interface ErrorBase {
  readonly message: string
}

// Configuration errors
export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<
  ErrorBase & { readonly searchPaths: readonly string[] }
> {}

export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<
  ErrorBase & { readonly path: string; readonly errors: readonly string[] }
> {}

// Database errors
export class ConnectionFailed extends Data.TaggedError("ConnectionFailed")<
  ErrorBase & { readonly connectionString: string; readonly cause: unknown }
> {}

export class IntrospectionFailed extends Data.TaggedError("IntrospectionFailed")<
  ErrorBase & { readonly schema: string; readonly cause: unknown }
> {}

// Smart tags errors
export class TagParseError extends Data.TaggedError("TagParseError")<
  ErrorBase & {
    readonly objectType: "table" | "column" | "constraint" | "type"
    readonly objectName: string
    readonly comment: string
    readonly cause: unknown
  }
> {}

// Plugin errors
export class DuplicatePlugin extends Data.TaggedError("DuplicatePlugin")<
  ErrorBase & { readonly plugin: string }
> {}

export class CapabilityNotSatisfied extends Data.TaggedError("CapabilityNotSatisfied")<
  ErrorBase & { readonly required: string; readonly requiredBy: string }
> {}

export class CapabilityConflict extends Data.TaggedError("CapabilityConflict")<
  ErrorBase & { readonly capability: string; readonly providers: readonly string[] }
> {}

export class CapabilityCycle extends Data.TaggedError("CapabilityCycle")<
  ErrorBase & { readonly cycle: readonly string[] }
> {}

export class PluginConfigInvalid extends Data.TaggedError("PluginConfigInvalid")<
  ErrorBase & { readonly plugin: string; readonly errors: readonly string[] }
> {}

export class PluginExecutionFailed extends Data.TaggedError("PluginExecutionFailed")<
  ErrorBase & {
    readonly plugin: string
    readonly entity?: string
    readonly field?: string
    readonly cause: unknown
    readonly hint?: string
  }
> {}

// Emission errors
export class EmitConflict extends Data.TaggedError("EmitConflict")<
  ErrorBase & { readonly path: string; readonly plugins: readonly string[] }
> {}

export class SymbolConflict extends Data.TaggedError("SymbolConflict")<
  ErrorBase & { 
    readonly symbol: string
    readonly file: string
    readonly plugins: readonly string[] 
  }
> {}

export class WriteError extends Data.TaggedError("WriteError")<
  ErrorBase & { readonly path: string; readonly cause: unknown }
> {}

export class FormatError extends Data.TaggedError("FormatError")<
  ErrorBase & { readonly path: string; readonly cause: unknown }
> {}

// Union of all errors for convenience
export type SourcererError =
  | ConfigNotFound
  | ConfigInvalid
  | ConnectionFailed
  | IntrospectionFailed
  | TagParseError
  | DuplicatePlugin
  | CapabilityNotSatisfied
  | CapabilityConflict
  | CapabilityCycle
  | PluginConfigInvalid
  | PluginExecutionFailed
  | EmitConflict
  | SymbolConflict
  | WriteError
  | FormatError
