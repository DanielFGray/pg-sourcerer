/**
 * Zod Plugin - Generates Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with optional inferred TypeScript types.
 *
 * Capabilities provided:
 * - `schema:zod:EntityName` for each table entity (Row schema)
 * - `schema:zod:EntityName:insert` for Insert shape
 * - `schema:zod:EntityName:update` for Update shape
 * - `schema:zod:EnumName` for enum entities
 */
import { Effect, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { IR } from "../services/ir.js";
import {
  isTableEntity,
  isEnumEntity,
  type TableEntity,
  type Field,
  type EnumEntity,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import type {
  SchemaBuilder,
  SchemaBuilderRequest,
  SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import {
  pgStringTypes,
  pgNumberTypes,
  pgBooleanTypes,
  pgDateTypes,
  pgJsonTypes,
  resolveFieldTypeInfo,
} from "./shared/pg-types.js";
import {
  buildEnumDeclarations,
  buildSchemaBuilderDeclaration,
  buildShapeDeclarations,
} from "./shared/schema-declarations.js";

/**
 * Creates a consume callback for Zod schemas.
 * Generates: `SchemaName.parse(input)`
 *
 * @param schemaName - The name of the Zod schema
 * @returns A function that generates parse AST for an input expression
 */
function createZodConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure
      .id(schemaName)
      .method("parse", [cast.toExpr(input as n.Expression)])
      .build();
  };
}

/**
 * Zod SchemaBuilder implementation.
 * Builds Zod schemas for path/query parameters.
 */
const zodSchemaBuilder: SchemaBuilder = {
  build(request: SchemaBuilderRequest): SchemaBuilderResult | undefined {
    if (request.params.length === 0) {
      return undefined;
    }

    // Build z.object({ field: z.type(), ... })
    let objBuilder = conjure.obj();
    for (const param of request.params) {
      const zodType = paramToZodType(param);
      objBuilder = objBuilder.prop(param.name, zodType);
    }

    const ast = conjure.id("z").method("object", [objBuilder.build()]).build();
    const consume = (input: n.Expression) =>
      b.callExpression(b.memberExpression(cast.toExpr(ast), b.identifier("parse")), [
        cast.toExpr(input),
      ]);

    return {
      ast,
      importSpec: { from: "zod", names: ["z"] },
      consume,
    };
  },
};

/**
 * Convert a QueryMethodParam to a Zod type expression.
 */
function paramToZodType(param: { type: string; required: boolean }): n.Expression {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  let zodChain = conjure.id("z");
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      zodChain = zodChain.prop("coerce").method("number");
      break;
    case "boolean":
    case "bool":
      zodChain = zodChain.method("boolean");
      break;
    case "date":
      zodChain = zodChain.prop("coerce").method("date");
      break;
    case "string":
    default:
      zodChain = zodChain.method("string");
      break;
  }

  if (!param.required) {
    zodChain = zodChain.method("optional");
  }

  return zodChain.build();
}

const b = conjure.b;

const ZodSchemaConfig = S.Struct({
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof ZodSchemaConfig>;

/**
 * Zod plugin configuration.
 *
 * @example
 * // Basic usage - all schemas in schemas.ts
 * zod()
 *
 * @example
 * // Per-entity schema files
 * zod({
 *   schemasFile: ({ entityName }) => `${entityName.toLowerCase()}/schemas.ts`,
 * })
 */
export interface ZodConfig {
  /** Export inferred TypeScript types alongside schemas (default: true) */
  exportTypes?: boolean;
  /**
   * Output file path for schemas.
   * Can be a string (static path) or function (dynamic per entity).
   * @default "schemas.ts"
   */
  schemasFile?: string | FileNaming;
}

/** Resolved config with defaults applied */
interface ResolvedZodConfig extends SchemaConfig {
  schemasFile: FileNaming;
}

function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind;
}

// =============================================================================
// PostgreSQL Type to Zod Schema Mapping
// =============================================================================

/**
 * Result of mapping a field to Zod.
 * - `schema`: Zod schema expression (e.g., z.string(), z.number())
 * - `enumRef`: Reference to a separately defined enum schema
 */
type ZodMapping =
  | { kind: "schema"; schema: n.Expression; enumRef?: undefined }
  | { kind: "enumRef"; enumRef: string; schema?: undefined };

function fieldToZodMapping(field: Field, enums: EnumEntity[]): ZodMapping {
  const resolved = resolveFieldTypeInfo(field);
  if (!resolved) {
    return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
  }
  const baseResult = baseTypeToZodMapping(resolved.typeName, resolved.typeInfo, enums);

  // For enum references, return as-is (modifiers applied in shapeToZodObject)
  if (baseResult.kind === "enumRef") {
    return baseResult;
  }

  let schema = baseResult.schema;

  if (field.isArray) {
    schema = conjure.chain(schema).method("array").build();
  }

  const methods: string[] = [];
  if (field.nullable) methods.push("nullable");
  if (field.optional) methods.push("optional");

  for (const method of methods) {
    schema = conjure.chain(schema).method(method).build();
  }

  return { kind: "schema", schema };
}

function baseTypeToZodMapping(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): ZodMapping {
  const normalized = typeName.toLowerCase();

  if (pgStringTypes.has(normalized)) {
    if (normalized === "uuid") {
      return { kind: "schema", schema: conjure.id("z").method("uuid").build() };
    }
    // citext is case-insensitive text - just treat as regular string
    // (Zod doesn't have a built-in case-insensitive string validator)
    return { kind: "schema", schema: conjure.id("z").method("string").build() };
  }

  if (pgNumberTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("number").build() };
  }

  if (pgBooleanTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("boolean").build() };
  }

  if (pgDateTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").prop("coerce").method("date").build() };
  }

  if (pgJsonTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("any").build() };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      // Return reference to the enum schema instead of inlining
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
  }

  return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
}

// =============================================================================
// Shape to Zod Object
// =============================================================================

function shapeToZodObject(
  shape: { fields: readonly Field[] },
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.Expression {
  const properties = shape.fields.map(field => {
    const mapping = fieldToZodMapping(field, enums);

    let value: n.Expression;
    if (mapping.kind === "enumRef") {
      // Get handle and track cross-reference
      const enumHandle = registry.import(`schema:zod:${mapping.enumRef}`);
      value = enumHandle.ref() as n.Expression;

      // Apply modifiers for enum references
      if (field.isArray) {
        value = conjure.chain(value).method("array").build();
      }
      if (field.nullable) {
        value = conjure.chain(value).method("nullable").build();
      }
      if (field.optional) {
        value = conjure.chain(value).method("optional").build();
      }
    } else {
      value = mapping.schema;
    }

    return b.objectProperty(b.identifier(field.name), toExpr(value));
  });

  const objExpr = b.objectExpression(properties);
  const zObject = b.callExpression(b.memberExpression(b.identifier("z"), b.identifier("object")), [
    objExpr,
  ]);
  return zObject;
}

// =============================================================================
// Zod Plugin Definition
// =============================================================================

export function zod(config?: ZodConfig): Plugin {
  // Parse schema-validated options
  const schemaConfig = S.decodeSync(ZodSchemaConfig)(config ?? {});

  // Resolve file naming
  const resolvedConfig: ResolvedZodConfig = {
    ...schemaConfig,
    schemasFile: normalizeFileNaming(config?.schemasFile, "schemas.ts"),
  };

  return {
    name: "zod",

    provides: ["schema"],

    fileDefaults: [
      {
        pattern: "schema:",
        fileNaming: resolvedConfig.schemasFile,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      const enumEntities = [...ir.entities.values()].filter(isEnumEntity);
      for (const entity of enumEntities) {
        declarations.push(...buildEnumDeclarations(entity, "schema:zod"));
      }

      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;
        // Push declarations directly - they already include baseEntityName
        declarations.push(...buildShapeDeclarations(entity, "schema:zod"));
      }

      // Declare the schema builder capability
      declarations.push(buildSchemaBuilderDeclaration("zodSchemaBuilder", "schema:zod"));

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;

      const enums = [...ir.entities.values()].filter(isEnumEntity);

      const rendered: RenderedSymbol[] = [];

      for (const entity of enums) {
        const schemaNode = conjure
          .id("z")
          .method("enum", [conjure.arr(...entity.values.map(v => conjure.str(v))).build()])
          .build();

        const schemaDecl = conjure.export.const(entity.name, schemaNode);

        const inferType = conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof(entity.name)]);
        const typeDecl = conjure.export.type(entity.name, inferType);

        rendered.push({
          name: entity.name,
          capability: `schema:zod:${entity.name}`,
          node: schemaDecl,
          exports: "named",
          externalImports: [{ from: "zod", names: ["z"] }],
          metadata: {
            consume: createZodConsumeCallback(entity.name),
          },
        });

        if (resolvedConfig.exportTypes) {
          rendered.push({
            name: entity.name,
            capability: `schema:zod:${entity.name}:type`,
            node: typeDecl,
            exports: "named",
            externalImports: [{ from: "zod", names: ["z"] }],
          });
        }
      }

      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;

        const shapes: NonNullable<TableEntity["shapes"]["row" | "insert" | "update"]>[] = [
          entity.shapes.row,
        ];
        if (entity.shapes.insert) shapes.push(entity.shapes.insert);
        if (entity.shapes.update) shapes.push(entity.shapes.update);

        for (const shape of shapes) {
          const isRow = shape.kind === "row";
          const capability = `schema:zod:${shape.name}`;

          // Scope cross-references to this specific capability
          const schemaNode = registry.forSymbol(capability, () =>
            shapeToZodObject(shape, enums, registry),
          );

          const schemaDecl = conjure.export.const(shape.name, schemaNode);

          rendered.push({
            name: shape.name,
            capability,
            node: schemaDecl,
            exports: "named",
            externalImports: [{ from: "zod", names: ["z"] }],
            metadata: {
              consume: createZodConsumeCallback(shape.name),
            },
          });

          if (resolvedConfig.exportTypes && !isRow) {
            const inferType = conjure.ts.qualifiedRef("z", "infer", [
              conjure.ts.typeof(shape.name),
            ]);
            const typeDecl = conjure.export.type(shape.name, inferType);

            rendered.push({
              name: shape.name,
              capability: `schema:zod:${shape.name}:type`,
              node: typeDecl,
              exports: "named",
              externalImports: [{ from: "zod", names: ["z"] }],
            });
          }
        }
      }

      // Render the schema builder (virtual symbol - no node, just metadata)
      // The builder is used by HTTP plugins to generate inline param schemas
      rendered.push({
        name: "zodSchemaBuilder",
        capability: "schema:zod:builder",
        node: null, // Virtual symbol - no emitted code
        exports: false, // Not exported
        metadata: {
          builder: zodSchemaBuilder,
        },
      });

      return rendered;
    }),
  };
}
