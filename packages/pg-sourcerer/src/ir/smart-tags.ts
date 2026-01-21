/**
 * Smart Tags - configuration extracted from PostgreSQL COMMENT ON statements
 */
import { Schema as S } from "effect";

/**
 * Shape kinds for omit filtering
 */
export const ShapeKind = S.Literal("row", "insert", "update");
export type ShapeKind = S.Schema.Type<typeof ShapeKind>;

/**
 * Smart tags schema - extracted from pg_description comments
 * Format: {"sourcerer": {...}} in the comment text
 */
export const SmartTags = S.Struct({
  // Renaming
  name: S.optional(S.String),

  // Omission: true = omit entirely, array = omit from specific shapes
  omit: S.optional(S.Union(S.Boolean, S.Array(ShapeKind))),

  // Type override (emitter-specific, passed through as string)
  type: S.optional(S.String),

  // Deprecation: true = deprecated, string = deprecated with message
  deprecated: S.optional(S.Union(S.Boolean, S.String)),

  // For views: define virtual primary key
  primaryKey: S.optional(S.Array(S.String)),

  // For constraints: relation naming
  fieldName: S.optional(S.String),
  foreignFieldName: S.optional(S.String),
}).pipe(
  // Extension point: plugins can define additional keys
  S.extend(S.Record({ key: S.String, value: S.Unknown })),
);

export type SmartTags = S.Schema.Type<typeof SmartTags>;
