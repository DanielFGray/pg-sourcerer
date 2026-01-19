/**
 * ArkType Plugin - Generates ArkType schemas for entities
 *
 * Generates ArkType schemas for Row, Insert, Update, and Patch shapes,
 * with optional inferred TypeScript types.
 *
 * Capabilities provided:
 * - `schema:arktype:EntityName` for each table entity (Row schema)
 * - `schema:arktype:EntityName:insert` for Insert shape
 * - `schema:arktype:EntityName:update` for Update shape
 * - `schema:arktype:EnumName` for enum entities
 */
import { Effect, Array as Arr, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

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
import { conjure, cast } from "../conjure/index.js";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import type {
  SchemaBuilder,
  SchemaBuilderRequest,
  SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";

/**
 * Creates a consume callback for ArkType schemas.
 * Generates: `SchemaName.assert(input)` (throws on validation error)
 *
 * @param schemaName - The name of the ArkType schema
 * @returns A function that generates assert AST for an input expression
 */
function createArkTypeConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure.id(schemaName).method("assert", [cast.toExpr(input as n.Expression)]).build();
  };
}

/**
 * Convert a param type to an ArkType type string.
 */
function paramToArkTypeString(param: { type: string; required: boolean }): string {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  let arkType: string;
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      arkType = "number";
      break;
    case "boolean":
    case "bool":
      arkType = "boolean";
      break;
    case "date":
      arkType = "Date";
      break;
    case "string":
    default:
      arkType = "string";
      break;
  }

  if (!param.required) {
    arkType = `${arkType}?`;
  }

  return arkType;
}

/**
 * ArkType SchemaBuilder implementation.
 * Builds ArkType schemas for path/query parameters.
 */
const arkTypeSchemaBuilder: SchemaBuilder = {
  build(request: SchemaBuilderRequest): SchemaBuilderResult | undefined {
    if (request.params.length === 0) {
      return undefined;
    }

    // Build type({ field: "string", ... })
    const typeObj: Record<string, string> = {};
    for (const param of request.params) {
      typeObj[param.name] = paramToArkTypeString(param);
    }

    // Generate: type({ id: "number", email: "string" })
    let objBuilder = conjure.obj();
    for (const [name, arkType] of Object.entries(typeObj)) {
      objBuilder = objBuilder.prop(name, conjure.str(arkType));
    }

    const ast = conjure.id("type").call([objBuilder.build()]).build();

    return {
      ast,
      importSpec: { from: "arktype", names: ["type"] },
    };
  },
};

const ArkTypeSchemaConfig = S.Struct({
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof ArkTypeSchemaConfig>;

/**
 * ArkType plugin configuration.
 *
 * @example
 * // Basic usage - all schemas in schemas.ts
 * arktype()
 *
 * @example
 * // Per-entity schema files
 * arktype({
 *   schemasFile: ({ entityName }) => `${entityName.toLowerCase()}/schemas.ts`,
 * })
 */
export interface ArkTypeConfig {
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
interface ResolvedArkTypeConfig extends SchemaConfig {
  schemasFile: FileNaming;
}

function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind;
}

// =============================================================================
// PostgreSQL Type to ArkType String Mapping
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
// Field to ArkType Type String
// =============================================================================

function fieldToArkTypeString(field: Field, enums: EnumEntity[]): string {
  const pgType = field.pgAttribute.getType();

  if (!pgType) {
    return "unknown";
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

  let typeStr = baseTypeToArkType(typeName, typeInfo, enums);

  if (field.isArray) {
    typeStr = `${typeStr}[]`;
  }

  if (field.nullable) {
    typeStr = `${typeStr} | null`;
  }

  if (field.optional) {
    typeStr = `${typeStr}?`;
  }

  return typeStr;
}

function baseTypeToArkType(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): string {
  const normalized = typeName.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) {
    if (normalized === "uuid") {
      return "string.uuid";
    }
    if (normalized === "citext") {
      return "string.lowercase";
    }
    return "string";
  }

  if (PG_NUMBER_TYPES.has(normalized)) {
    return "number";
  }

  if (PG_BOOLEAN_TYPES.has(normalized)) {
    return "boolean";
  }

  if (PG_DATE_TYPES.has(normalized)) {
    return "Date";
  }

  if (PG_JSON_TYPES.has(normalized)) {
    return "unknown";
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      return enumEntity.values.map(v => `'${v}'`).join(" | ");
    }
    return "unknown";
  }

  return "unknown";
}

// =============================================================================
// Shape to ArkType Object
// =============================================================================

function shapeToArkTypeObject(
  shape: { fields: readonly Field[] },
  enums: EnumEntity[],
): n.Expression {
  let objBuilder = conjure.obj();
  for (const field of shape.fields) {
    const typeStr = fieldToArkTypeString(field, enums);
    objBuilder = objBuilder.prop(field.name, conjure.str(typeStr));
  }
  return conjure.id("type").call([objBuilder.build()]).build();
}

// =============================================================================
// ArkType Plugin Definition
// =============================================================================

function getShapeDeclarations(entity: TableEntity): SymbolDeclaration[] {
  const declarations: SymbolDeclaration[] = [];
  const baseEntityName = entity.name;

  declarations.push({
    name: entity.shapes.row.name,
    capability: `schema:arktype:${entity.shapes.row.name}`,
    baseEntityName,
  });

  if (entity.shapes.insert) {
    const insertName = entity.shapes.insert.name;
    declarations.push({
      name: insertName,
      capability: `schema:arktype:${insertName}`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
    declarations.push({
      name: insertName,
      capability: `schema:arktype:${insertName}:type`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
  }

  if (entity.shapes.update) {
    const updateName = entity.shapes.update.name;
    declarations.push({
      name: updateName,
      capability: `schema:arktype:${updateName}`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
    declarations.push({
      name: updateName,
      capability: `schema:arktype:${updateName}:type`,
      dependsOn: [`type:${entity.name}`],
      baseEntityName,
    });
  }

  return declarations;
}

export function arktype(config?: ArkTypeConfig): Plugin {
  const schemaConfig = S.decodeSync(ArkTypeSchemaConfig)(config ?? {});

  const resolvedConfig: ResolvedArkTypeConfig = {
    ...schemaConfig,
    schemasFile: normalizeFileNaming(config?.schemasFile, "schemas.ts"),
  };

  return {
    name: "arktype",

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
          declarations.push(...getShapeDeclarations(entity));
        } else if (isEnumEntity(entity)) {
          declarations.push({
            name: entity.name,
            capability: `schema:arktype:${entity.name}`,
            baseEntityName: entity.name,
          });
          declarations.push({
            name: entity.name,
            capability: `schema:arktype:${entity.name}:type`,
            baseEntityName: entity.name,
          });
        }
      }

      // Declare the schema builder capability
      declarations.push({
        name: "arkTypeSchemaBuilder",
        capability: "schema:arktype:builder",
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
            const schemaNode = shapeToArkTypeObject(shape, enums);

            const schemaDecl = conjure.export.const(shape.name, schemaNode);

            rendered.push({
              name: shape.name,
              capability: `schema:arktype:${shape.name}`,
              node: schemaDecl,
              exports: "named",
              externalImports: [{ from: "arktype", names: ["type"] }],
              metadata: {
                consume: createArkTypeConsumeCallback(shape.name),
              },
            });

            if (resolvedConfig.exportTypes && !isRow) {
              const inferType = conjure.ts.typeof(`${shape.name}.infer`);
              const typeDecl = conjure.export.type(shape.name, inferType);

              rendered.push({
                name: shape.name,
                capability: `schema:arktype:${shape.name}:type`,
                node: typeDecl,
                exports: "named",
                externalImports: [{ from: "arktype", names: ["type"] }],
              });
            }
          }
        } else if (isEnumEntity(entity)) {
          const enumString = entity.values.map(v => `'${v}'`).join(" | ");
          const schemaNode = conjure.id("type").call([conjure.str(enumString)]).build();

          const schemaDecl = conjure.export.const(entity.name, schemaNode);

          const inferType = conjure.ts.typeof(`${entity.name}.infer`);
          const typeDecl = conjure.export.type(entity.name, inferType);

          rendered.push({
            name: entity.name,
            capability: `schema:arktype:${entity.name}`,
            node: schemaDecl,
            exports: "named",
            externalImports: [{ from: "arktype", names: ["type"] }],
            metadata: {
              consume: createArkTypeConsumeCallback(entity.name),
            },
          });

          if (resolvedConfig.exportTypes) {
            rendered.push({
              name: entity.name,
              capability: `schema:arktype:${entity.name}:type`,
              node: typeDecl,
              exports: "named",
              externalImports: [{ from: "arktype", names: ["type"] }],
            });
          }
        }
      }

      // Render the schema builder (virtual symbol - no node, just metadata)
      // The builder is used by HTTP plugins to generate inline param schemas
      rendered.push({
        name: "arkTypeSchemaBuilder",
        capability: "schema:arktype:builder",
        node: null, // Virtual symbol - no emitted code
        exports: false, // Not exported
        metadata: {
          builder: arkTypeSchemaBuilder,
        },
      });

      return rendered;
    }),
  };
}
