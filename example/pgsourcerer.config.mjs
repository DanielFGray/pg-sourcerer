// @ts-check
import { makeTypesPlugin, makeQueriesPlugin, makeZodSchemasPlugin, defineConfig } from "../index.mjs";
import { camelize } from "inflection";

/** @param {string} str */
const camelCase = (str) => camelize(str, true)

const schemas = ["app_public"];

export default defineConfig({
  adapter: "pg",
  outputDir: "./generated",
  connectionString: process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL,
  role: process.env.DATABASE_VISITOR,
  inflections: { columnNames: camelCase },
  typeMap: {
    "app_public.username": "string",
    "app_public.url": "string",
    "public.citext": "string",
  },
  plugins: [
    // makeTypesPlugin({ schemas, path: () => `./types.ts` }),
    makeZodSchemasPlugin({ schemas, path: () => `./schemas.ts` }),
    makeQueriesPlugin({ schemas, path: () => `./queries.ts` }),
  ],
});
