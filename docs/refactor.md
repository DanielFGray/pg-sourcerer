# pg-sourcerer Refactor Plan

This plan reorganizes `packages/core/index.mjs` into a modular, testable library with a thin CLI, fixes correctness issues in query/codegen paths, and adds small targeted tests to lock in behavior.

## Goals
- Separate CLI concerns from the library API for testability.
- Make the plugin pipeline composable and type-safe.
- Fix correctness in query building, import merging, and codegen.
- Remove Node/Bun path quirks and fragile patterns.
- Add targeted tests for critical utilities.

## Proposed Module Layout

- `bin/pgs.mjs`
  - CLI entry only: parse config, call `run()`, handle `process.exit`.
- `src/index.mjs`
  - Public surface: `run()`, `defineConfig`, and re-exports for plugin makers.
- `src/config.mjs`
  - `userConfig` Zod schema, `parseConfig()`, defaults, and error reporting.
- `src/db/introspection.mjs`
  - `introspect(config)`: connect via `pg`, run `makeIntrospectionQuery()`, `parseIntrospectionResults`, build our `Introspection` shape.
- `src/plugin/runner.mjs`
  - `runPlugins({ introspection, config, plugins })`: compose inflections (without mutating `config`), feed phases, return `outputs`.
- `src/codegen/writer.mjs`
  - `writeOutputs({ outputs, outputDir, extension })`: group by `path`, build import declarations, print via `recast`, and write files.
- `src/utils/*`
  - `ast.mjs`: `id()`, `tsRef()`, `tsLiteralUnion()`, `getASTTypeFromTypeName()`.
  - `types.mjs`: `getTSTypeNameFromPgType()` (never returns null; returns `"unknown"` or throws with hint to `typeMap`).
  - `permissions.mjs`, `path.mjs` (`makePathFromConfig()`), `sql.mjs` (`queryBuilder()`), `operators.mjs` (`getOperatorsFrom()`).
- `src/plugins/*`
  - `types.mjs`, `zod.mjs`, `queries.mjs`, `http.mjs` extracted and unit-testable.

## Public API and Contracts

- `defineConfig(config)` — returns the config as-is for DX.
- `run()` — orchestrates parseConfig → introspect → runPlugins → writeOutputs.
- `Plugin` shape:
  - `render(ctx): Output[]`
  - `ctx`: `{ introspection, prevOutput, config, inflect, utils }`
- `Output` shape:
  - `path: string`
  - `content: ASTNode | ASTNode[]`
  - `imports?: ImportSpec[]`
  - `exports?: Array<{ identifier: string; kind: "type" | "zodSchema" | Record<string, () => any> }>`
- `ImportSpec`:
  - `{ identifier: string; path: string; default?: boolean; typeImport?: boolean }`

## Key Implementation Changes

### 1) CLI / Library Split
- Move shebang and `main()` invocation to `bin/pgs.mjs`.
- Export `run()` from the library; only CLI uses `process.exit()`.
- Update `packages/core/package.json`:
  - `"bin": { "pgs": "./bin/pgs.mjs" }`
  - Consider setting `"type": "module"` for clarity.

### 2) Introspection
- Use `makeIntrospectionQuery()` from `pg-introspection` instead of reading `introspectionQuery.sql` directly.
- Wrap PG usage:
  - `withPgClient(connStr, role?, (client) => {...})` to manage begin/rollback and role.
- Build the internal `Introspection` shape via helpers:
  - `processSchema`, `processTables`, `processViews`, `processFunctions`, `processTypes`.

### 3) Inflections
- Do not mutate `config.inflections`.
- Compute `resolvedInflections`: functions with identity defaults (e.g., `columns: s => s`).
- Combine `user.inflections[key]` with all plugin-provided `inflections[key]` arrays and fold via `transform(str, steps)`.
- Pass `inflect` (the resolved functions) into plugin `render(ctx)`.

### 4) Output Grouping and Imports
- Replace accidental use of `groupBy`/`Object.groupBy` with a local `groupByPath()` helper.
- `parseDependencies()`:
  - Group by `path`, combine default and named specifiers, dedupe identifiers.
  - Compute `importKind` per declaration: `type` if all specs are `typeImport`, else `value`.
- Always `await` file writes; use `for...of` instead of `forEach(async ...)`.
- Log with `path.relative(process.cwd(), outFile)` to avoid `import.meta.dirname`.

### 5) Types Plugin
- Enum AST should be: `type X = "A" | "B"` using `b.tsUnionType(values.map(v => b.tsLiteralType(b.stringLiteral(v))))`.
- Ensure `id` is `b.identifier(name)` consistently.
- Return homogeneous `Output` objects; build enums and table types separately and map each to an `Output`.

### 6) Zod Plugin
- Primitive mapping: `string`, `number`, `boolean`, `date`, `unknown`.
- Fallback for unmapped PG types:
  - Use `typeMap` from config if provided.
  - Else produce `z.unknown()` (configurable: warn or throw).
- Apply nullable with `.nullable()`; union not needed for zod schema values.
- Avoid double-inflection of identifiers; define `identifier` once per table and reuse.

### 7) Queries Plugin
- Fix index handling:
  - `const column = table.columns[index.colnames[0]];` (avoid mixing array/object shapes).
- Correct type lookup:
  - `const tsTypeName = utils.getTSTypeNameFromPgType(column.type, config);`
- Normalize options:
  - Use a single key `order` in `QueryData`; `queryBuilder()` respects it.
- Insert builder:
  - Use a single source of truth for columns: `const keys = patch ?? Object.keys(params)`; placeholders via `keys.map(() => "?")`.
- Param typing:
  - If `type` is a named model, use `b.tsTypeReference(b.identifier(type))`.
  - Use `getASTTypeFromTypeName` only for primitives.
- Type imports:
  - Ensure referenced type is imported via `findExport()`.

### 8) Writer
- Deterministic output order by sorting paths.
- Respect `tabWidth: 2` in recast print options; optionally expose a `dryRun`.

## Bug Fixes Checklist
- Replace `Object.groupBy` and anonymous `groupBy` with local helpers.
- Await all asynchronous writes; no `forEach(async ...)`.
- Fix `idxColumns` misuse (single column vs array).
- Align `order`/`orderBy` usage in queries + builder.
- Insert values: placeholder count matches column count.
- `getTSTypeNameFromPgType` never returns `null`; either `unknown` or throw with hint to `typeMap`.
- Enum and zod AST correctness (literal unions; proper identifier usage).
- Logging path fix (no `import.meta.dirname`).

## Testing (Targeted)
- `sql.queryBuilder`:
  - SELECT: where, joins, order, pagination; param order list.
  - INSERT/UPDATE/DELETE: columns-to-placeholder mapping; params list.
- `codegen.imports`:
  - Merge type-only and value imports per path; combine default + named; dedupe.
- `plugins/queries`:
  - Primary key lookup by unique index → returnsMany false.
  - Unique index vs non-unique.
  - tsvector search query shape.
  - timestamptz latest vs generic `by_<col>` ordering.
- `utils/types`:
  - PG→TS mapping including `typeMap` overrides.

## Migration Notes
- Update `packages/core/package.json`:
  - `bin.pgs` → `./bin/pgs.mjs`.
  - Consider `"type": "module"`.
- Demo config continues to import plugin makers and `defineConfig` from core public entry (now `src/index.mjs` or bundled output).
- Keep backwards compatibility by re-exporting from a stable entry path used by the demo.

## Example Skeletons

- `bin/pgs.mjs`
  ```js
  #!/usr/bin/env node
  import { run } from "../src/index.mjs";

  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
  ```

- `src/index.mjs`
  ```js
  import { parseConfig, defineConfig } from "./config.mjs";
  import { introspect } from "./db/introspection.mjs";
  import { runPlugins } from "./plugin/runner.mjs";
  import { writeOutputs } from "./codegen/writer.mjs";

  export async function run() {
    const config = await parseConfig();
    const introspection = await introspect(config);
    const outputs = runPlugins({ introspection, config, plugins: config.plugins });
    await writeOutputs({ outputs, outputDir: config.outputDir, extension: config.outputExtension });
  }

  export { defineConfig } from "./config.mjs";
  export { makeTypesPlugin } from "./plugins/types.mjs";
  export { makeZodSchemasPlugin } from "./plugins/zod.mjs";
  export { makeQueriesPlugin } from "./plugins/queries.mjs";
  export { makeHttpPlugin } from "./plugins/http.mjs";
  ```

## Open Questions
- Should unknown PG types cause a hard error (fail fast) vs generate `z.unknown()` and warn? Make it configurable.
- Expose a `--dry-run` CLI flag for codegen preview?
- Emit source maps and/or write per-file banners indicating generated content?

---
This document is intentionally detailed to guide incremental refactoring while keeping the demo functional. Tackle items in the order listed under “Key Implementation Changes,” validating with the suggested tests as you go.
