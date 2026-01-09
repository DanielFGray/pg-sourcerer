import {
  defineConfig,
  arktypePlugin,
  kyselyTypesPlugin,
  kyselyQueriesPlugin,
} from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  plugins: [arktypePlugin(), kyselyTypesPlugin(), kyselyQueriesPlugin()],
});
