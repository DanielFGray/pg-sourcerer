import { makeTypesPlugin, createQueriesPlugin } from ".";

const schemas = ["app_public", "app_private"]

/** @type {import('./index').Config} */
export default {
  adapter: "pg",
  connectionString: process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL,
  role: process.env.DATABASE_VISITOR,
  outputDir: "./generated",
  plugins: [
    makeTypesPlugin({ schemas }),
    createQueriesPlugin({ schemas }),
  ],
};
