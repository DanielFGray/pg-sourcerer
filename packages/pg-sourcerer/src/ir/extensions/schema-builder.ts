/**
 * Schema Builder Contract
 *
 * Defines the interface for schema plugins to provide inline schema generation
 * capabilities to HTTP plugins. This enables http-elysia to generate param/query
 * schemas using whatever schema library (Zod, ArkType, Valibot) is configured.
 *
 * Schema plugins register this service via ctx.registerHandler("schema-builder", ...).
 * HTTP plugins consume via ctx.request("schema-builder", params).
 */
import type { namedTypes as n } from "ast-types";
import type { QueryMethodParam } from "./queries.js";

/**
 * Import specification for the schema library.
 */
export interface SchemaImportSpec {
  /** Named imports, e.g., ["z"] for Zod */
  readonly names?: readonly string[];
  /** Namespace import, e.g., "v" for Valibot */
  readonly namespace?: string;
  /** Package name, e.g., "zod" */
  readonly from: string;
}

/**
 * Request params for schema-builder service.
 */
export interface SchemaBuilderRequest {
  /** What kind of schema to build */
  readonly variant: "params" | "query";
  /** The parameters to generate schema for */
  readonly params: readonly QueryMethodParam[];
}

/**
 * Result from schema-builder service.
 */
export interface SchemaBuilderResult {
  /** The AST expression for the schema (e.g., z.object({ id: z.string() })) */
  readonly ast: n.Expression;
  /** Import needed for the schema library */
  readonly importSpec: SchemaImportSpec;
}

/**
 * Schema builder service interface.
 *
 * Implemented by schema plugins (zod, arktype, valibot).
 * Consumed by HTTP plugins (http-elysia, http-hono).
 */
export interface SchemaBuilder {
  /**
   * Build a schema for path/query parameters.
   *
   * @param request - What to build and from what params
   * @returns AST expression and import spec, or undefined if cannot build
   */
  readonly build: (request: SchemaBuilderRequest) => SchemaBuilderResult | undefined;
}

/**
 * Service kind for schema-builder.
 */
export const SCHEMA_BUILDER_KIND = "schema-builder" as const;
