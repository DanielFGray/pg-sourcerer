// @ts-check
import * as utils from "../utils/index.mjs";
import invariant from "tiny-invariant";

const b = utils.builders;

/**
 * Map a PostgreSQL type to an Effect Schema constructor identifier
 * Returns one of the S.* identifiers to be called with no args, e.g. "UUID", "Number"
 * Fallback is "NonEmptyTrimmedString" per spec for string-like unknowns
 * @param {string} pgType
 * @returns {"UUID"|"Boolean"|"Number"|"BigInt"|"Date"|"Unknown"|"NonEmptyTrimmedString"}
 */
function mapPgToEffect(pgType) {
  switch (pgType) {
    // numbers
    case "pg_catalog.int2":
    case "pg_catalog.int4":
    case "pg_catalog.float4":
    case "pg_catalog.float8":
    case "pg_catalog.numeric":
      return "Number";
    case "pg_catalog.int8":
      return "BigInt";

    // strings
    case "pg_catalog.char":
    case "pg_catalog.bpchar":
    case "pg_catalog.varchar":
    case "pg_catalog.text":
    case "pg_catalog.name":
    case "public.citext":
      return "NonEmptyTrimmedString";

    // booleans
    case "pg_catalog.bool":
      return "Boolean";

    // dates
    case "pg_catalog.date":
    case "pg_catalog.time":
    case "pg_catalog.timetz":
    case "pg_catalog.timestamp":
    case "pg_catalog.timestamptz":
      return "Date";

    // json
    case "pg_catalog.json":
    case "pg_catalog.jsonb":
      return "Unknown";

    // uuid
    case "pg_catalog.uuid":
      return "UUID";

    // ranges/inet/unknown -> string-like fallback
    case "pg_catalog.int4range":
    case "pg_catalog.int8range":
    case "pg_catalog.numrange":
    case "pg_catalog.tsrange":
    case "pg_catalog.tstzrange":
    case "pg_catalog.daterange":
    case "pg_catalog.inet":
    default:
      return "NonEmptyTrimmedString";
  }
}

/**
 * Build S.<name> (member access, not a call - primitives are values, not functions)
 * @param {string} name
 */
function sPrimitive(name) {
  return b.memberExpression(b.identifier("S"), b.identifier(name));
}

/**
 * Wrap with S.Array(expr)
 * @param {import("ast-types").namedTypes.Expression} inner
 */
function sArray(inner) {
  return b.callExpression(b.memberExpression(b.identifier("S"), b.identifier("Array")), [inner]);
}

/**
 * Wrap with S.NullOr(expr)
 * @param {import("ast-types").namedTypes.Expression} inner
 */
function sNullOr(inner) {
  return b.callExpression(b.memberExpression(b.identifier("S"), b.identifier("NullOr")), [inner]);
}

/**
 * Model.Generated(expr)
 * @param {import("ast-types").namedTypes.Expression} inner
 */
function modelGenerated(inner) {
  return b.callExpression(b.memberExpression(b.identifier("Model"), b.identifier("Generated")), [
    inner,
  ]);
}

/** Create identifier with optional schema prefix */
function withSchemaPrefix(name, schemaName, prefixWithSchema) {
  if (!prefixWithSchema) return name;
  const prefix = utils.transform(schemaName, ["classify"]);
  return `${prefix}${name}`;
}

/**
 * Resolve schema identifier function from config, falling back to identity
 * @param {import("../index.mjs").Config} config
 * @param {"models"|"types"} key
 */
function getInflect(config, key) {
  const fn = /** @type {any} */ (config.inflections)[key];
  if (typeof fn === "function") return fn;
  // fallback: identity
  return s => s;
}

/** @type {(opts: {
 *   schemas?: Array<string>
 *   tables?: Array<string>
 *   path?: string | ((o: { schema: string, name: string }) => string) | string[]
 *   prefixWithSchema?: boolean
 *   typeMap?: Record<string, string>
 * }) => import("../index.mjs").Plugin} */
export const makeEffectModelsPlugin = pluginOpts => ({
  name: "effect-models",
  inflections: {
    types: ["camelize", "singularize"],
    models: ["camelize", "singularize"],
  },
  render({ introspection, config, output }) {
    const colInflect = /** @type {(s:string)=>string} */ (config.inflections.columns || (s => s));
    const modelInflect = getInflect(config, "models");
    const typeInflect = getInflect(config, "types");
    const prefixWithSchema = pluginOpts?.prefixWithSchema ?? false;

    /** @type {Array<import("../index.mjs").Output>} */
    const outputs = [];

    for (const schema of Object.values(introspection.schemas)) {
      if (!(pluginOpts?.schemas?.includes(schema.name) ?? true)) continue;

      // Flatten types array if necessary (introspection may group by name)
      const allTypes = Object.values(schema.types).flatMap(t => (Array.isArray(t) ? t : [t]));

      // Enums -> export const <Name> = S.Union(S.Literal(...), ...)
      for (const t of allTypes) {
        if (!t || t.kind !== "enum") continue;
        const baseName = typeInflect(t.name);
        const identifier = withSchemaPrefix(baseName, schema.name, prefixWithSchema);
        const literals = t.values.map(v =>
          b.callExpression(b.memberExpression(b.identifier("S"), b.identifier("Literal")), [
            b.literal(v),
          ]),
        );
        const unionCall = b.callExpression(
          b.memberExpression(b.identifier("S"), b.identifier("Union")),
          literals,
        );
        const decl = b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier(identifier), unionCall),
          ]),
        );
        outputs.push({
          path: utils.makePathFromConfig({
            config: { ...config, pluginOpts },
            schema: schema.name,
            name: identifier,
          }),
          content: decl,
          imports: [{ identifier: "Schema", default: false, path: "effect", as: "S" }],
          exports: [{ identifier, kind: "schema" }],
        });
      }

      // Domains -> export const <Name> = S.<MappedBase>()
      for (const t of allTypes) {
        if (!t || t.kind !== "domain") continue;
        const baseName = typeInflect(t.name);
        const identifier = withSchemaPrefix(baseName, schema.name, prefixWithSchema);
        // t.type may be plain base like 'text', map to pg_catalog.<type> where sensible
        const pgBase = t.type.startsWith("pg_catalog.") ? t.type : `pg_catalog.${t.type}`;
        const mapped = pluginOpts?.typeMap?.[pgBase] || mapPgToEffect(pgBase);
        const expr = sPrimitive(mapped);
        const decl = b.exportNamedDeclaration(
          b.variableDeclaration("const", [b.variableDeclarator(b.identifier(identifier), expr)]),
        );
        outputs.push({
          path: utils.makePathFromConfig({
            config: { ...config, pluginOpts },
            schema: schema.name,
            name: identifier,
          }),
          content: decl,
          imports: [{ identifier: "Schema", default: false, path: "effect", as: "S" }],
          exports: [{ identifier, kind: "schema" }],
        });
      }

      // Composites -> export const <Name> = S.Struct({ ... })
      for (const t of allTypes) {
        if (!t || t.kind !== "composite") continue;
        const baseName = typeInflect(t.name);
        const identifier = withSchemaPrefix(baseName, schema.name, prefixWithSchema);

        const fields = t.values.map(v => {
          // v.type is namespaced or base, try to map
          const effectCtor = mapPgToEffect(
            v.type.startsWith("pg_catalog.") ? v.type : `pg_catalog.${v.type}`,
          );
          const expr = sPrimitive(effectCtor);
          return b.objectProperty.from({ key: b.literal(colInflect(v.name)), value: expr });
        });
        const structCall = b.callExpression(
          b.memberExpression(b.identifier("S"), b.identifier("Struct")),
          [b.objectExpression(fields)],
        );
        const decl = b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier(identifier), structCall),
          ]),
        );
        outputs.push({
          path: utils.makePathFromConfig({
            config: { ...config, pluginOpts },
            schema: schema.name,
            name: identifier,
          }),
          content: decl,
          imports: [{ identifier: "Schema", default: false, path: "effect", as: "S" }],
          exports: [{ identifier, kind: "schema" }],
        });
      }

      // Tables -> export class <Model> extends Model.Class<...>("...")({ ... }) {}
      for (const table of Object.values(schema.tables)) {
        if (!(pluginOpts?.tables?.includes(table.name) ?? true)) continue;
        const classBase = modelInflect(table.name);
        const className = withSchemaPrefix(classBase, schema.name, prefixWithSchema);

        /** @type {Array<import("../index.mjs").ImportSpec>} */
        const imports = [
          { identifier: "Model", default: false, path: "@effect/sql" },
          { identifier: "Schema", default: false, path: "effect", as: "S" },
        ];

        const properties = Object.values(table.columns).map(c => {
          // Determine base expression for property
          /** @type {import("recast").types.namedTypes.Expression} */
          let expr;

          // detect enum/domain by matching local type name
          const typeNameParts = c.type.split(".");
          const [typeSchema, localTypeName] =
            typeNameParts.length > 1 ? [typeNameParts[0], typeNameParts[1]] : [schema.name, c.type];

          // Try to find an enum/domain export in current outputs
          const enumOrDomain = allTypes.find(
            t => (t.kind === "enum" || t.kind === "domain") && t.name === localTypeName,
          );
          if (enumOrDomain) {
            const refBase = typeInflect(enumOrDomain.name);
            const refIdent = withSchemaPrefix(refBase, schema.name, prefixWithSchema);
            expr = b.identifier(refIdent);
            // If the referenced identifier is in a different file, ensure import gets added
            try {
              const ref = utils.findExports({
                output: outputs,
                identifier: refIdent,
                kind: "schema",
              });
              // only add import if paths differ; we add after computing our own path
              // We'll compare after we know our path (below)
              // Temporarily stash for later
              // we'll handle after building class path
            } catch (_) {
              // no-op; it may be in same file we are writing
            }
          } else {
            // direct mapping
            const mapped = mapPgToEffect(c.type);
            expr = sPrimitive(mapped);
          }

          if (c.isArray) expr = sArray(expr);
          if (c.nullable) expr = sNullOr(expr);

          // Generated heuristic
          const isGenerated =
            Boolean(c.identity) ||
            c.generated === "STORED" ||
            (!c.permissions.canInsert && !c.permissions.canUpdate);
          if (isGenerated) expr = modelGenerated(expr);

          const prop = b.objectProperty.from({
            key: b.identifier(colInflect(c.name)),
            value: expr,
            comments: c.description ? [b.commentBlock(`* ${c.description} `)] : null,
          });
          return prop;
        });

        // Build class super call: Model.Class<ClassName>("ClassName")({ ... })
        const classTypeRef = b.tsTypeReference(b.identifier(className));
        const classGeneric = b.tsInstantiationExpression.from({
          expression: b.memberExpression(b.identifier("Model"), b.identifier("Class")),
          typeParameters: b.tsTypeParameterInstantiation([classTypeRef]),
        });
        const firstCall = b.callExpression(classGeneric, [b.literal(className)]);
        const finalCall = b.callExpression(firstCall, [b.objectExpression(properties)]);

        const classDecl = b.exportNamedDeclaration(
          b.classDeclaration.from({
            id: b.identifier(className),
            superClass: finalCall,
            body: b.classBody([]),
          }),
        );

        const filePath = utils.makePathFromConfig({
          config: { ...config, pluginOpts },
          schema: schema.name,
          name: className,
        });

        // Ensure imports for any enum/domain referenced that live in different files
        for (const t of allTypes) {
          if (t.kind !== "enum" && t.kind !== "domain") continue;
          const refBase = typeInflect(t.name);
          const refIdent = withSchemaPrefix(refBase, schema.name, prefixWithSchema);
          // Check if any column uses this type
          const used = Object.values(table.columns).some(c => {
            const parts = c.type.split(".");
            const local = parts.length > 1 ? parts[1] : c.type;
            return local === t.name;
          });
          if (!used) continue;
          try {
            const ref = utils.findExports({
              output: outputs,
              identifier: refIdent,
              kind: "schema",
            });
            if (ref.path !== filePath) {
              // Convert .ts file path to relative import path with .js extension
              const relativePath = "./" + ref.path.replace(/^\.\//, "").replace(/\.ts$/, ".js");
              imports.push({ ...ref, path: relativePath });
            }
          } catch (_) {
            // referenced type may be in same file (same path) or not yet registered; if same file, fine
          }
        }

        outputs.push({
          path: filePath,
          content: classDecl,
          imports,
          exports: [{ identifier: className, kind: { class: () => ({ name: className }) } }],
        });
      }
    }

    return outputs;
  },
});
