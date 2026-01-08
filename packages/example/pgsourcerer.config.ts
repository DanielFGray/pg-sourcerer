// @ts-check
import {
  defineConfig,
  inflect,
  typesPlugin,
  arktypePlugin,
  zodPlugin,
  effectModelPlugin,
  sqlQueriesPlugin,
} from "@danielfgray/pg-sourcerer";

/**
 * pg-sourcerer configuration for the example project
 *
 * Generates Effect Model classes from the database schema.
 */
export default defineConfig({
  connectionString: process.env.AUTH_DATABASE_URL!, // ?? process.env.DATABASE_URL ?? "",
  role: "visitor",

  // Schemas to introspect
  schemas: ["app_public", "app_private"],

  // Output directory (relative to config file location)
  outputDir: "./generated",

  // Inflection: PascalCase entities/enums, camelCase fields
  inflection: {
    entityName: name => inflect.pascalCase(inflect.singularize(name)),
    fieldName: inflect.camelCase,
    enumName: inflect.pascalCase,
    shapeSuffix: inflect.capitalize,
  },

  // Plugins to run
  plugins: [
    // Generate TypeScript types
    typesPlugin({ outputDir: "types" }),

    // Generate Zod schemas
    // zodPlugin({ outputDir: "zod", exportTypes: false }),

    // Generate ArkType schemas
    arktypePlugin({ outputDir: "ark", exportTypes: true }),

    // Generate Effect Model classes
    effectModelPlugin({ outputDir: "effect" }),

    // Generate SQL query functions
    sqlQueriesPlugin({ outputDir: "queries" }),
  ],
});
