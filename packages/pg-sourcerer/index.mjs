// @ts-check
import path from "path";
import _debug from "debug";
import fs from "fs/promises";
import recast from "recast";
import { lilconfig } from "lilconfig";
import { z } from "zod";
import partition from "lodash.partition";
import groupBy from "lodash.groupby";
import invariant from "tiny-invariant";
import * as utils from "./utils/index.mjs";
import { introspect } from "./introspection.mjs";
import { parseArgs } from "util";

// Re-export plugins
export { makeTypesPlugin } from "./plugins/types.mjs";
export { makeZodSchemasPlugin } from "./plugins/schemas.mjs";
export { makeQueriesPlugin } from "./plugins/queries.mjs";
export { makeHttpPlugin } from "./plugins/http.mjs";
export { makeEffectModelsPlugin } from "./plugins/effect-models.mjs";

// Guard main execution to prevent running when imported
if (import.meta.main) {
  main();
}

const debug = _debug("pg-sourcerer");

const inflectionsSchema = z
  .record(
    z.array(
      z.union([
        z.literal("pluralize"),
        z.literal("singularize"),
        z.literal("camelize"),
        z.literal("underscore"),
        z.literal("humanize"),
        z.literal("capitalize"),
        z.literal("dasherize"),
        z.literal("titleize"),
        z.literal("demodulize"),
        z.literal("tableize"),
        z.literal("classify"),
        z.literal("foreignKey"),
        z.literal("ordinalize"),
      ]),
    ),
  )
  .optional();
const OutputSchema = z.object({
  content: z.any(), // ast builder can take care of itself
  path: z.string(),
  exports: z
    .array(
      z.object({
        identifier: z.string(),
        kind: z.union([
          z.literal("type"),
          z.literal("zodSchema"),
          z.record(
            // z.union([
            z.function(z.tuple([]), z.any()),
            // ]),
          ),
        ]),
      }),
    )
    .refine(
      entries => {
        const [values, types] = partition(entries, e => e.kind === "type");
        const typeIdentifiers = new Set(types.map(e => e.identifier));
        const valueIdentifiers = new Set(values.map(e => e.identifier));
        return typeIdentifiers.size === types.length && valueIdentifiers.size === values.length;
      },
      { message: "export identifiers must be unique" },
    ),
  imports: z
    .array(
      z
              .object({
                typeImport: z.boolean().optional(),
                identifier: z.string(),
                default: z.boolean().optional(),
                path: z.string(),
                as: z.string().optional(),
              })
        .strict(),
    )
    .optional(),
});

export const UserConfig = z.object({
  connectionString: z.string(),
  outputDir: z.string(),
  typeMap: z
    .record(
      z.union([
        z.literal("string"),
        z.literal("boolean"),
        z.literal("number"),
        z.literal("Date"),
        z.literal("unknown"),
      ]),
    )
    .optional(),
  role: z.string().optional(),
  inflections: inflectionsSchema,
  plugins: z.array(
    z.object({
      name: z.string(),
      inflections: inflectionsSchema,
      // TODO: other possible phases?
      render: z
        .function()
        .args(z.any())
        .returns(z.union([z.array(OutputSchema), z.promise(z.array(OutputSchema))])),
    }),
  ),
});

/** @typedef {z.infer<typeof UserConfig>} UserConfig */
/** @typedef {z.infer<typeof inflectionsSchema>} Inflections */

/**
 * @param {string} [path]
 * @returns {Promise<UserConfig>}
 */
export async function parseConfig(path) {
  const explorer = lilconfig("pgsourcerer");
  let configSearch = await (path ? explorer.load(path) : explorer.search());
  if (!configSearch) {
    console.error("a pgsourcerer config is required");
    // TODO: what if we codegen a config from prompts?
    process.exit(1);
  }
  const parseResult = UserConfig.safeParse(configSearch.config);
  if (!parseResult.success) {
    console.log(parseResult.error.flatten());
    process.exit(1);
  }
  return parseResult.data;
}

/** @typedef {{ typeImport?: boolean, identifier: string, default?: boolean, path: string, as?: string}} ImportSpec */

/** @typedef {z.infer<typeof OutputSchema>} Output */

/** @typedef {import('./introspection.mjs').DbIntrospection} DbIntrospection */

/** @typedef {{
 *   name: string,
 *   inflections?: Inflections;
 *   render(info: {
 *     introspection: DbIntrospection
 *     output: Array<Output>;
 *     config: Config;
 *   }): Array<Output> | Promise<Array<Output>>
 * }} Plugin */

/** @typedef {Omit<UserConfig, 'inflections' | 'plugins'> & {
 *   plugins: Plugin[]
 *   inflections: Record<string, (s: string) => string>
 * }} Config */

async function main() {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: {
        type: "string",
        short: "C",
      },
    },
  });

  const config = processConfig(await parseConfig(args.config));

  if (!("plugins" in config) || config.plugins.length < 1) {
    console.error("no plugins defined, nothing to do");
    return process.exit(0);
  }

  const introspection = await introspect(config);

  const output = await pluginRunner(config, introspection);

  if (!output) {
    console.error("no output from plugins");
    return process.exit(1);
  }

  await writeFiles(serializer(output, config.outputDir));
}

/**
 * @param {UserConfig} userConfig
 * @returns {Config}
 */
function processConfig(userConfig) {
  const inflections = userConfig.plugins.reduce(
    (o, plugin) => {
      if (plugin.inflections) {
        for (const key in plugin.inflections) {
          const inflections = (userConfig.inflections?.[key] ?? []).concat(
            plugin.inflections[key] ?? [],
          );
          o[key] = str => utils.transform(str, inflections);
        }
      }
      return o;
    },
    /** @type {Record<string, (s: string) => string>} */ ({ columns: s => s }),
  );

  return /** @type {const} */ ({
    ...userConfig,
    inflections,
  });
}

/**
 * @param {Config} config
 * @param {DbIntrospection} introspection
 */
export async function pluginRunner(config, introspection) {
  return config.plugins.reduce(
    (prev, plugin) =>
      prev.then(output =>
        Promise.resolve(
          plugin.render({
            introspection,
            output,
            config,
          }),
        ).then(result => output.concat(result)),
      ),
    /** @type {Promise<Array<Output>>} */ (Promise.resolve([])),
  );
}

/** @typedef {{ code: string; path: string }} SerializedOutput */

/**
 * Writes plugin output to disk
 * @param {Array<Output>} output - Plugin output to write
 * @param {string} outputDir
 * @returns {Array<SerializedOutput>}
 */
function serializer(output, outputDir) {
  return Object.entries(groupBy(output, o => o.path)).map(([strPath, files]) => {
    const newPath = path.join(outputDir ?? "./", strPath);
    const { code } = recast.print(
      recast.types.builders.program([
        ...utils.parseDependencies(files.flatMap(f => f.imports ?? [])),
        ...files.flatMap(f => f.content),
      ]),
      { tabWidth: 2 },
    );
    return { code, path: newPath };
  });
}

/**
 * Writes plugin output to disk
 * @param {Array<SerializedOutput>} output - Plugin output to write
 * @returns {Promise<void>}
 */
export async function writeFiles(output) {
  await Promise.all(
    output.map(async result => {
      const { dir } = path.parse(result.path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(result.path, result.code, "utf8");
      console.log('wrote file "%s"', result.path.replace(import.meta.dirname, "."));
    }),
  );
}

/**
 * @param {UserConfig} config
 * @returns {UserConfig}
 */
export function defineConfig(config) {
  return config;
}

/**
 * Test helper functions for creating mock data
 */

/**
 * Creates a mock configuration object for testing
 * @param {Partial<UserConfig>} overrides - Override specific config values
 * @returns {UserConfig}
 */
export function createMockConfig(overrides = {}) {
  return defineConfig({
    connectionString: "postgresql://test:test@localhost:5432/test",
    outputDir: "./generated",
    typeMap: {},
    inflections: {
      types: ["classify"],
      columns: [],
    },
    plugins: [],
    ...overrides,
  });
}

/**
 * Creates a mock introspection object for testing
 * @param {Partial<DbIntrospection>} overrides - Override specific introspection values
 * @returns {DbIntrospection}
 */
export function createMockIntrospection(overrides = {}) {
  return {
    name: "test_db",
    schemas: {
      public: {
        name: "public",
        tables: {},
        views: {},
        functions: {},
        types: {},
      },
    },
    ...overrides,
  };
}

/**
 * Creates a mock plugin for testing
 * @param {string} name - Plugin name
 * @param {Array<Output>} outputs - Mock outputs to return
 * @returns {Plugin}
 */
export function createMockPlugin(name, outputs = []) {
  return {
    name,
    render: () => outputs,
  };
}

export { transform } from "inflection";
