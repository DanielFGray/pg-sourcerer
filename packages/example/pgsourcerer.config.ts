// @ts-check
import { typesPlugin, zodPlugin, defineConfig } from "@danielfgray/pg-sourcerer"

/**
 * pg-sourcerer configuration for the example project
 *
 * Generates TypeScript types and Zod schemas from the database schema.
 */
export default defineConfig({
  // Database connection - uses environment variables
  connectionString: process.env.AUTH_DATABASE_URL ?? process.env.DATABASE_URL ?? "",

  // Schemas to introspect
  schemas: ["app_public", "app_private"],

  // Output directory (relative to config file location)
  outputDir: "./generated",

  // Type hints for custom type mappings
  typeHints: [
    {
      match: { pgType: "url" },
      hints: { tsType: "string" },
    },
    {
      match: { pgType: "username" },
      hints: { tsType: "string" },
    },
    {
      match: { pgType: "tsvector" },
      hints: { tsType: "string" },
    },
    {
      match: { pgType: "citext" },
      hints: { tsType: "string" },
    },
  ],

  // Plugins to run
  plugins: [
    // Generate TypeScript interfaces
    { plugin: typesPlugin, config: { outputDir: "types" } },

    // Generate Zod validation schemas with inferred types
    { plugin: zodPlugin, config: { outputDir: "schemas", exportTypes: true } },
  ],
})
