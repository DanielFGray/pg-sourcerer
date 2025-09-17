// @ts-check
import {
  makeZodSchemasPlugin,
  makeQueriesPlugin,
  makeHttpPlugin,
  makeEffectModelsPlugin,
  defineConfig,
} from "@danielfgray/pg-sourcerer";
import fs from "fs/promises";
import path from "path";

const schemas = [
  // "public",
  "app_public",
  "app_private",
];
const tables = ["users", "posts", "comments"];

const outputDir = path.resolve("./generated");

export default defineConfig({
  adapter: "postgres",
  outputDir,
  outputExtension: "ts",
  connectionString: process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL,
  role: process.env.DATABASE_VISITOR,
  schemas,
  typeMap: {
    "app_public.url": "string",
    "app_public.username": "string",
    "pg_catalog.tsvector": "string",
    "public.citext": "string",
  },
  inflections: {
    // columns: ['camelize'],
  },
  plugins: [
    {
      name: "clean",
      async render() {
        await fs.rm(outputDir, { recursive: true, force: true });
        return [];
      },
    },
    // makeTypesPlugin({
    // 	tables,
    // 	schemas,
    // 	path: ["pluralize", "camelize"],
    // 	// path: './types',
    // }),
    // makeZodSchemasPlugin({
    //   // tables,
    //   schemas,
    //   exportType: true,
    //   path: ["pluralize", "camelize"],
    //   // path: './schemas',
    // }),
    // makeQueriesPlugin({
    //   // tables,
    //   schemas,
    //   adapter: "postgres",
    //   path: ["camelize"],
    //   // path: './queries',
    // }),
    makeEffectModelsPlugin({
      schemas,
      // tables,
      // Group by model name by default; users can override path to group all
      path: ["camelize"],
      prefixWithSchema: false,
    }),
    makeHttpPlugin({
      // path: ({ name }) => `./${transform(name, ['camelize'])}.ts`
    }),
  ],
});
