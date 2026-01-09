import {
  defineConfig,
  classicInflectionConfig,
  typesPlugin,
  arktypePlugin,
  sqlQueriesPlugin,
} from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public"],
  outputDir: "./generated",
  formatter: "prettier --write",
  inflection: classicInflectionConfig,

  plugins: [typesPlugin(), arktypePlugin(), sqlQueriesPlugin()]
});
