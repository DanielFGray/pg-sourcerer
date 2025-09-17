// @ts-check
import recast from "recast";
import { transform } from "inflection";
import groupBy from "lodash.groupby";
import invariant from "tiny-invariant";
import { entityPermissions } from "pg-introspection";
import _debug from "debug";

const debug = _debug("pg-sourcerer");

/** @typedef {Array<import("../index.mjs").ImportSpec>} ImportSpec */

export const builders = recast.types.builders;

/**
 * @param {string} type
 */
export function getASTTypeFromTypeName(type) {
  const b = builders;
  switch (type) {
    case "string":
      return b.tsStringKeyword();
    case "boolean":
      return b.tsBooleanKeyword();
    case "Date":
      return b.tsTypeReference(b.identifier("Date"));
    case "number":
      return b.tsNumberKeyword();
    case "unknown":
      return b.tsUnknownKeyword();
    // case "array":
    //   return b.tsArrayType(b.tsStringKeyword());
    default:
      debug(`unknown type "${type}"`);
      return b.tsUnknownKeyword();
  }
}

/**
 * @param {string} pgTypeString
 * @param {import("../index.mjs").Config} config
 * @returns {"string" | "boolean" | "number" | "Date" | "unknown"}
 */
export function getTSTypeNameFromPgType(pgTypeString, config) {
  switch (pgTypeString) {
    case "pg_catalog.int2":
    case "pg_catalog.int4":
    case "pg_catalog.float4":
    case "pg_catalog.float8":
      return "number";
    case "pg_catalog.int8":
    case "pg_catalog.numeric":
    case "pg_catalog.char":
    case "pg_catalog.bpchar":
    case "pg_catalog.varchar":
    case "pg_catalog.text":
    case "pg_catalog.uuid":
    case "pg_catalog.inet":
    case "pg_catalog.int4range":
    case "pg_catalog.int8range":
    case "pg_catalog.numrange":
    case "pg_catalog.tsrange":
    case "pg_catalog.tstzrange":
    case "pg_catalog.daterange":
      return "string";
    case "pg_catalog.bool":
      return "boolean";
    case "pg_catalog.date":
    case "pg_catalog.time":
    case "pg_catalog.timetz":
    case "pg_catalog.timestamp":
    case "pg_catalog.timestamptz":
      return "Date";
    case "pg_catalog.json":
    case "pg_catalog.jsonb":
      return "unknown";
    default:
      if (config.typeMap && pgTypeString in config.typeMap) {
        return config.typeMap[pgTypeString];
      }
      debug(`unknown PgTypeString "${pgTypeString}"`);
      return null;
  }
}

/**
 * @param {{
 *   index: import("../introspection.mjs").DbIndex,
 *   column: import("../introspection.mjs").DbColumn
 * }} _
 */
export function getOperatorsFrom({ column, index }) {
  switch (true) {
    case column.type === "pg_catalog.tsvector":
      return ["@@"];
    case Boolean(column.isArray && index.type === "gin"):
      return ["@>"];
    case column.type === "pg_catalog.timestamptz" && index.type === "btree":
      return ["=", "<", ">", "<=", ">=", "between"];
    default:
      return ["="];
  }
}

/**
 * @param {{
 *   output: Array<import("../index.mjs").Output>,
 *   identifier: string,
 *   kind: import("../index.mjs").Output['exports']['kind']
 * }} _
 */
export function findExports({ output, identifier, kind }) {
  for (let i = 0; i < output.length; i++) {
    const r = output[i];
    if (!r) continue;
    const e = r.exports?.find(e => e.kind === kind && e.identifier === identifier);
    if (e) {
      /** @type {import("../index.mjs").ImportSpec} */
      return { identifier: e.identifier, path: r.path, typeImport: kind === "type" };
    }
  }
  console.log(output.flatMap(e => e.exports));
  throw new Error(`could not type export for ${identifier}`);
}

// TODO: not handled: import <default>, { [type] <named> } from '<path>'
export function parseDependencies(deps) {
  const b = recast.types.builders;

  // Group imports by path
  const depsByPath = groupBy(deps, d => d.path);

  return Object.entries(depsByPath).flatMap(([path, pathDeps]) => {
    const [defaultTypeImports, otherImports] = pathDeps.reduce(
      ([defaultTypes, others], d) =>
        d.default && d.typeImport ? [[...defaultTypes, d], others] : [defaultTypes, [...others, d]],
      /**  */ [[], []],
    );

    const defaultTypeDeclarations = defaultTypeImports.map(d =>
      b.importDeclaration.from({
        importKind: "type",
        specifiers: [b.importDefaultSpecifier(b.identifier(d.identifier))],
        source: b.literal(path),
      }),
    );

    const mixedImportDeclarations =
      otherImports.length > 0
        ? [
            b.importDeclaration.from({
              specifiers: otherImports.map(d =>
                d.default
                  ? b.importDefaultSpecifier(b.identifier(d.identifier))
                  : b.importSpecifier.from({
                                        imported: b.identifier(d.identifier),
                                        local: b.identifier(d.as || d.identifier),
                                      }),
              ),
              source: b.literal(path),
            }),
          ]
        : [];

    return [...defaultTypeDeclarations, ...mixedImportDeclarations];
  });
}

/**
 * @param {{
 *   config: import("../index.mjs").Config & {
 *     pluginOpts: {
 *       pathInflection?: string[],
 *       path: string | ((s: { schema: string, name: string }) => string)
 *     }
 *   },
 *   schema: string,
 *   name: string
 * }} _
 */
export function makePathFromConfig({ config, schema, name }) {
  switch (true) {
    case typeof config.pluginOpts.path === "function":
      return config.pluginOpts.path({ schema, name }).concat(".ts");

    case typeof config.pluginOpts.path === "string":
      return config.pluginOpts.path.concat(".ts");

    case config.pluginOpts.path instanceof Array &&
      config.pluginOpts.path.every(x => typeof x === "string"):
      return transform(name, config.pluginOpts.path).concat(".ts");

    default:
      return `./${name}.ts`;
  }
}

/**
 * @param {any} data
 */
export function stringify(data) {
  return JSON.stringify(
    data,
    (_key, value) => {
      const type = Object.prototype.toString.call(value).slice(8, -1);
      switch (true) {
        case type.endsWith("Function"):
          return `[${type}]`;
        default:
          return value;
      }
    },
    2,
  );
}

// Re-export transform for convenience
export { transform };
