import { defineConfig, arktype } from "./packages/pg-sourcerer/src/index.js";

export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public"],
  outputDir: "./test-output",
  plugins: [arktype()],
});
