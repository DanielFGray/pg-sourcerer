import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Specific rules for redundant type definitions
    rules: {
      // Disallow explicit type annotations when they can be inferred
      "@typescript-eslint/no-inferrable-types": "error",

      // Prefer using type parameter on Array<T> vs T[] (stylistic)
      // "@typescript-eslint/array-type": ["error", { default: "generic" }],

      // Enforce using 'as const' instead of literal type annotations
      "@typescript-eslint/prefer-as-const": "error",

      // No redundant type constituents (e.g., `string | never`)
      "@typescript-eslint/no-redundant-type-constituents": "error",

      // No useless template expressions (`` `${string}` `` → just use string)
      "@typescript-eslint/no-unnecessary-template-expression": "error",

      // Allow unused variables prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Ignore non-TS files and build outputs
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
    ],
  }
);
