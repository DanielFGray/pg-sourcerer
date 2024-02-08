import {
  makeTypesPlugin,
  makeZodSchemasPlugin,
  makeQueriesPlugin,
  makeHttpPlugin,
  defineConfig,
  transform,
} from "../index.mjs";
import path from "path";
import { rimraf } from "rimraf";

const schemas = [
  // "public",
  "app_public",
  // "app_private"
];
const tables = ["users", "posts", "comments"];

const outputDir = path.resolve("./generated");

export default defineConfig({
  adapter: "postgres",
  outputDir,
  outputExtension: "ts",
  connectionString: process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL,
  // role: process.env.DATABASE_VISITOR,
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
      render() {
        rimraf(outputDir);
        return [];
      },
    },
    // makeTypesPlugin({
    // 	tables,
    // 	schemas,
    // 	path: ["pluralize", "camelize"],
    // 	// path: './types',
    // }),
    makeZodSchemasPlugin({
      tables,
      schemas,
      exportType: true,
      path: ["pluralize", "camelize"],
      // path: './schemas',
    }),
    makeQueriesPlugin({
      tables,
      schemas,
      path: ["camelize"],
      // path: './queries',
    }),
    makeHttpPlugin({
      // path: ({ name }) => `./${transform(name, ['camelize'])}.ts`
    }),
  ],
});
