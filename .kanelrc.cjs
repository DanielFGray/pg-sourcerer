const { generateIndexFile } = require('kanel');

/** @type {import('kanel').Config} */
module.exports = {
  connection: {
    user: process.env.DATABASE_OWNER,
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT,
    database: process.env.DATABASE_NAME,
    password: process.env.DATABASE_OWNER_PASSWORD,
    charset: "utf8",
  },

  resolveViews: true,
  preDeleteOutputFolder: true,
  outputPath: "./generated/db",

  schemas: ["app_public", "app_private"],
  enumStyle: "type",

  preRenderHooks: [generateIndexFile],

  customTypeMap: {
    "pg_catalog.tsvector": "string",
    "pg_catalog.bpchar": "string",
    "public.citext": "citext",
  },

  tableNames: [
    "users",
    "comments",
    "posts"
  ],
  adapter: "postgres",
};
