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
import { Effect, Array as Arr, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import type { StatementKind } from "ast-types/lib/gen/kinds.js";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { IR } from "../services/ir.js";
import {
  isTableEntity,
  isEnumEntity,
  type TableEntity,
  type Field,
  type EnumEntity,
} from "../ir/semantic-ir.js";
import { SymbolRegistry } from "../runtime/registry.js";
import { conjure, cast } from "../conjure/index.js";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import type {
  SchemaBuilder,
  SchemaBuilderRequest,
  SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";

/**
 * Creates a consume callback for Zod schemas.
 * Generates: `SchemaName.parse(input)`
 *
 * @param schemaName - The name of the Zod schema
 * @returns A function that generates parse AST for an input expression
 */
function createZodConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure.id(schemaName).method("parse", [cast.toExpr(input as n.Expression)]).build();
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

    return {
      ast,
      importSpec: { from: "zod", names: ["z"] },
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

function toStmt(node: n.Statement): StatementKind {
  return node as StatementKind;
}

// =============================================================================
// PostgreSQL Type to Zod Schema Mapping
// =============================================================================

const PG_STRING_TYPES = new Set([
  "uuid",
  "text",
  "varchar",
  "char",
  "character",
  "name",
  "bpchar",
  "citext",
]);

const PG_NUMBER_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "integer",
  "smallint",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "float4",
  "float8",
  "double",
]);

const PG_BOOLEAN_TYPES = new Set(["bool", "boolean"]);

const PG_DATE_TYPES = new Set(["timestamp", "timestamptz", "date", "time", "timetz"]);

const PG_JSON_TYPES = new Set(["json", "jsonb"]);

// =============================================================================
// Field to Zod Schema
// =============================================================================

function fieldToZodSchema(field: Field, enums: EnumEntity[]): n.Expression {
  const pgType = field.pgAttribute.getType();

  if (!pgType) {
    return conjure.id("z").method("unknown").build();
  }

  // For arrays, use element type; for domains, use base type; otherwise use pgType
  let typeName: string;
  let typeInfo: { typcategory?: string | null; typtype?: string | null };

  if (pgType.typcategory === "A") {
    // Array type - use element type name
    typeName = field.elementTypeName ?? "unknown";
    typeInfo = pgType;
  } else if (pgType.typtype === "d" && field.domainBaseType) {
    // Domain type - resolve to underlying base type
    typeName = field.domainBaseType.typeName;
    typeInfo = { typcategory: field.domainBaseType.category };
  } else {
    typeName = pgType.typname;
    typeInfo = pgType;
  }

  let schema = baseTypeToZod(typeName, typeInfo, enums);

  if (field.isArray) {
    schema = conjure.chain(schema).method("array").build();
  }

  const methods: string[] = [];
  if (field.nullable) methods.push("nullable");
  if (field.optional) methods.push("optional");

  for (const method of methods) {
    schema = conjure.chain(schema).method(method).build();
  }

  return schema;
}

function baseTypeToZod(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): n.Expression {
  const normalized = typeName.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) {
    if (normalized === "uuid") {
      return conjure.id("z").method("uuid").build();
    }
    if (normalized === "citext") {
      return conjure.id("z").method("string").method("toLowerCase").build();
    }
    return conjure.id("z").method("string").build();
  }

  if (PG_NUMBER_TYPES.has(normalized)) {
    return conjure.id("z").method("number").build();
  }

  if (PG_BOOLEAN_TYPES.has(normalized)) {
    return conjure.id("z").method("boolean").build();
  }

  if (PG_DATE_TYPES.has(normalized)) {
    return conjure.id("z").method("coerce").method("date").build();
  }

  if (PG_JSON_TYPES.has(normalized)) {
    return conjure.id("z").method("unknown").build();
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      return conjure
        .id("z")
        .method("enum", [conjure.arr(...enumEntity.values.map(v => conjure.str(v))).build()])
        .build();
    }
    return conjure.id("z").method("unknown").build();
  }

  return conjure.id("z").method("unknown").build();
}

// =============================================================================
// Shape to Zod Object
// =============================================================================

function shapeToZodObject(shape: { fields: readonly Field[] }, enums: EnumEntity[]): n.Expression {
  const properties = shape.fields.map(field => {
    const value = fieldToZodSchema(field, enums);
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

function getShapeDeclarations(entity: TableEntity): SymbolDeclaration[] {
  const declarations: SymbolDeclaration[] = [];
  const baseEntityName = entity.name;

  // Row shape uses the entity name directly
  declarations.push({
    name: entity.shapes.row.name,
    capability: `schema:zod:${entity.shapes.row.name}`,
    baseEntityName,
  });

  if (entity.shapes.insert) {
    const insertName = entity.shapes.insert.name;
    declarations.push({
      name: insertName,
      capability: `schema:zod:${insertName}`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
    declarations.push({
      name: insertName,
      capability: `schema:zod:${insertName}:type`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
  }

  if (entity.shapes.update) {
    const updateName = entity.shapes.update.name;
    declarations.push({
      name: updateName,
      capability: `schema:zod:${updateName}`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
    declarations.push({
      name: updateName,
      capability: `schema:zod:${updateName}:type`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
  }

  return declarations;
}

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

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          // Push declarations directly - they already include baseEntityName
          declarations.push(...getShapeDeclarations(entity));
        } else if (isEnumEntity(entity)) {
          declarations.push({
            name: entity.name,
            capability: `schema:zod:${entity.name}`,
            baseEntityName: entity.name,
          });
          declarations.push({
            name: entity.name,
            capability: `schema:zod:${entity.name}:type`,
            baseEntityName: entity.name,
          });
        }
      }

      // Declare the schema builder capability
      declarations.push({
        name: "zodSchemaBuilder",
        capability: "schema:zod:builder",
      });

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;

      const enums = [...ir.entities.values()].filter(isEnumEntity);

      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          const shapes: NonNullable<TableEntity["shapes"]["row" | "insert" | "update"]>[] = [
            entity.shapes.row,
          ];
          if (entity.shapes.insert) shapes.push(entity.shapes.insert);
          if (entity.shapes.update) shapes.push(entity.shapes.update);

          for (const shape of shapes) {
            const isRow = shape.kind === "row";
            const schemaNode = shapeToZodObject(shape, enums);

            const schemaDecl = conjure.export.const(shape.name, schemaNode);

            rendered.push({
              name: shape.name,
              capability: `schema:zod:${shape.name}`,
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
        } else if (isEnumEntity(entity)) {
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
