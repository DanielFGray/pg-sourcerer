import { defineConfig, arktypePlugin, sqlQueriesPlugin } from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.AUTH_DATABASE_URL!,
  role: "visitor",
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    arktypePlugin({ exportTypes: true }),
    sqlQueriesPlugin({
      sqlStyle: "string",
      header: `import { pool } from "../../db.js";`,
    }),
  ],
});
