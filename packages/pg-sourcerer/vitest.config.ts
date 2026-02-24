import { defineConfig } from "vitest/config";
import { doctest } from "vite-plugin-doctest";

export default defineConfig({
  // @ts-expect-error - vite-plugin-doctest has peer dep on vite 5.x, vitest 3.x uses vite 7.x internally
  plugins: [doctest()],
  test: {
    include: ["src/**/*.test.ts"],
    // Enable doctest for JSDoc examples in source files
    includeSource: ["src/**/*.ts"],
    // Integration tests now use fixtures (no real DB needed), so include them
    exclude: ["node_modules"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        // Entry points - tested via integration/CLI tests
        "src/cli.ts",
        "src/index.ts",
        // Build scripts
        "scripts/**",
        // Test files and fixtures
        "**/*.test.ts",
        "**/fixtures/**",
      ],
    },
  },
});
