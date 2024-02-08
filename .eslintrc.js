module.exports = {
  parser: "@typescript-eslint/parser",
  extends: [
    "plugin:jsdoc/recommended",
    "eslint:recommended",
    "plugin:jsdoc/recommended-typescript-flavor",
  ],
  plugins: ["jsodc"],
  env: {
    node: true,
  },
  parserOptions: { project: "tsconfig.json" },
  ignorePatterns: ["./node_modules/"],
  rules: {},
};
