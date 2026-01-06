/**
 * Smart Tags Parser
 *
 * Parses JSON smart tags from PostgreSQL COMMENT ON statements.
 * Format: {"sourcerer": {...}} at the start of the comment,
 * with optional description text after a newline.
 */
import { Effect, Schema as S, pipe } from "effect"
import { SmartTags, emptySmartTags } from "../ir/smart-tags.js"
import { TagParseError } from "../errors.js"

/**
 * Result of parsing a comment
 */
export interface ParsedComment {
  readonly tags: SmartTags
  readonly description: string | undefined
}

/**
 * Context for error reporting
 */
export interface TagContext {
  readonly objectType: "table" | "column" | "constraint" | "type"
  readonly objectName: string
}

/**
 * Schema for the raw JSON wrapper containing sourcerer key
 */
const CommentJson = S.Struct({
  sourcerer: S.optional(S.Unknown),
}).pipe(S.extend(S.Record({ key: S.String, value: S.Unknown })))

/**
 * Parse smart tags from a PostgreSQL comment.
 *
 * Format:
 * - `{"sourcerer": {...}}` - JSON only
 * - `{"sourcerer": {...}}\ndescription` - JSON with description after newline
 * - `plain text` - no JSON, text is description
 * - `null/undefined/""` - no tags, no description
 *
 * Errors on malformed JSON or invalid sourcerer schema.
 */
export function parseSmartTags(
  comment: string | null | undefined,
  context: TagContext
): Effect.Effect<ParsedComment, TagParseError> {
  // Handle null/undefined/empty
  if (!comment || comment.trim() === "") {
    return Effect.succeed({ tags: emptySmartTags, description: undefined })
  }

  const trimmed = comment.trim()

  // If doesn't start with {, it's plain text description
  if (!trimmed.startsWith("{")) {
    return Effect.succeed({ tags: emptySmartTags, description: trimmed })
  }

  // Find the end of JSON and start of description
  // JSON ends at first newline, description is everything after
  const newlineIndex = trimmed.indexOf("\n")
  const jsonPart = newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex)
  const descriptionPart =
    newlineIndex === -1 ? undefined : trimmed.slice(newlineIndex + 1).trim() || undefined

  return pipe(
    // Parse JSON
    Effect.try({
      try: () => JSON.parse(jsonPart) as unknown,
      catch: (error) =>
        new TagParseError({
          message: `Invalid JSON in comment: ${error instanceof Error ? error.message : String(error)}`,
          objectType: context.objectType,
          objectName: context.objectName,
          comment,
          cause: error,
        }),
    }),
    // Validate wrapper structure and extract sourcerer
    Effect.flatMap((parsed) =>
      S.decodeUnknown(CommentJson)(parsed).pipe(
        Effect.mapError(
          (error) =>
            new TagParseError({
              message: `Invalid comment structure: ${error.message}`,
              objectType: context.objectType,
              objectName: context.objectName,
              comment,
              cause: error,
            })
        )
      )
    ),
    // Check for sourcerer key
    Effect.flatMap((wrapper) => {
      if (wrapper.sourcerer === undefined) {
        // Valid JSON but no sourcerer key - other tool's namespace
        return Effect.succeed({ tags: emptySmartTags, description: descriptionPart })
      }

      // Validate sourcerer against SmartTags schema
      return S.decodeUnknown(SmartTags)(wrapper.sourcerer).pipe(
        Effect.map((tags) => ({ tags, description: descriptionPart })),
        Effect.mapError(
          (error) =>
            new TagParseError({
              message: `Invalid sourcerer tags: ${error.message}`,
              objectType: context.objectType,
              objectName: context.objectName,
              comment,
              cause: error,
            })
        )
      )
    })
  )
}
