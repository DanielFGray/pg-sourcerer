// @ts-check
import { effectModelPlugin, typesPlugin, defineConfig, inflect } from "@danielfgray/pg-sourcerer"

/**
 * pg-sourcerer configuration for the example project
 *
 * Generates Effect Model classes from the database schema.
 */
export default defineConfig({
  // Database connection - uses environment variables
  connectionString: process.env.AUTH_DATABASE_URL ?? process.env.DATABASE_URL ?? "",

  // Schemas to introspect
  schemas: ["app_public", "app_private"],

  // Output directory (relative to config file location)
  outputDir: "./generated",

  // Inflection: PascalCase entities/enums, camelCase fields
  inflection: {
    entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
    fieldName: inflect.camelCase,
    enumName: inflect.pascalCase,
    shapeSuffix: inflect.capitalize,
  },

  // Plugins to run
  plugins: [
    // Generate TypeScript types
    typesPlugin({ outputDir: "types" }),
    // Generate Effect Model classes
    effectModelPlugin({ outputDir: "models" }),
  ],
})
