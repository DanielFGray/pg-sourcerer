import { makeTypesPlugin, createQueriesPlugin, makeZodSchemasPlugin } from "../index.mjs";
import { camelize } from "inflection";

const schemas = ["app_public"];

export default {
  adapter: "postgres",
  connectionString: process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL,
  role: process.env.DATABASE_VISITOR,
  outputDir: "./generated",
  inflections: {
    columnNames: (t) => camelize(t, true),
  },
  typeMap: {
    "app_public.username": "string",
    "app_public.url": "string",
    "public.citext": "string",
  },
  plugins: [
    // makeTypesPlugin({ schemas, path: (t) => `./${t.table}.ts` }),
    makeZodSchemasPlugin({ schemas, path: (t) => `./${t.table}.ts` }),
    createQueriesPlugin({ schemas, path: (t) => `./${t.table}.ts` }),
  ],
};
