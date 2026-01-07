import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
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
})
