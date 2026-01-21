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
// Field to ArkType Type
// =============================================================================

/**
 * Result of mapping a field to ArkType.
 * - `typeString`: ArkType string type (e.g., "string", "number", "string.uuid")
 * - `enumRef`: Reference to a separately defined enum schema
 */
type ArkTypeMapping =
  | { kind: "string"; typeString: string; enumRef?: undefined }
  | { kind: "enumRef"; enumRef: string; typeString?: undefined };

function fieldToArkType(field: Field, enums: EnumEntity[]): ArkTypeMapping {
  const pgType = field.pgAttribute.getType();

  if (!pgType) {
    return { kind: "string", typeString: "unknown" };
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

  const baseResult = baseTypeToArkType(typeName, typeInfo, enums);

  // For enum references, we can't easily add modifiers in string form,
  // so we handle them specially in shapeToArkTypeObject
  if (baseResult.kind === "enumRef") {
    return baseResult;
  }

  let typeStr = baseResult.typeString;

  if (field.isArray) {
    typeStr = `${typeStr}[]`;
  }

  if (field.nullable) {
    typeStr = `${typeStr} | null`;
  }

  if (field.optional) {
    typeStr = `${typeStr}?`;
  }

  return { kind: "string", typeString: typeStr };
}

function baseTypeToArkType(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): ArkTypeMapping {
  const normalized = typeName.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) {
    if (normalized === "uuid") {
      return { kind: "string", typeString: "string.uuid" };
    }
    // citext is case-insensitive text, but ArkType doesn't have a specific validator
    // Just treat it as a regular string
    return { kind: "string", typeString: "string" };
  }

  if (PG_NUMBER_TYPES.has(normalized)) {
    return { kind: "string", typeString: "number" };
  }

  if (PG_BOOLEAN_TYPES.has(normalized)) {
    return { kind: "string", typeString: "boolean" };
  }

  if (PG_DATE_TYPES.has(normalized)) {
    return { kind: "string", typeString: "Date" };
  }

  if (PG_JSON_TYPES.has(normalized)) {
    return { kind: "string", typeString: "unknown" };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      // Return reference to the enum schema instead of inlining
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "string", typeString: "unknown" };
  }

  return { kind: "string", typeString: "unknown" };
}

// =============================================================================
// Shape to ArkType Object
// =============================================================================

function shapeToArkTypeObject(
  shape: { fields: readonly Field[] },
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.Expression {
  let objBuilder = conjure.obj();

  for (const field of shape.fields) {
    const mapping = fieldToArkType(field, enums);

    if (mapping.kind === "enumRef") {
      // Get handle and track cross-reference
      const enumHandle = registry.import(`schema:arktype:${mapping.enumRef}`);
      let enumExpr = enumHandle.ref() as n.Expression;

      if (field.isArray) {
        enumExpr = conjure.chain(enumExpr).method("array").build();
      }
      if (field.nullable) {
        enumExpr = conjure.chain(enumExpr).method("or", [conjure.id("type").call([conjure.str("null")]).build()]).build();
      }
      // Note: ArkType doesn't have a direct .optional() method like Zod
      // Optional is typically handled at the object level with "key?" syntax
      // For now, we'll treat optional enum fields the same as required
      // This is a limitation - may need scope() for full support

      objBuilder = objBuilder.prop(field.name, enumExpr);
    } else {
      objBuilder = objBuilder.prop(field.name, conjure.str(mapping.typeString));
    }
  }

  return conjure.id("type").call([objBuilder.build()]).build();
}

/**
 * Build an UpdateInput schema: PK fields required, non-PK update fields optional.
 * This is used for update operations where we need to identify the row (PK) and
 * specify which fields to change (non-PK).
 */
function buildUpdateInputSchema(
  entity: TableEntity,
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.Expression | null {
  const updateShape = entity.shapes.update;
  const primaryKey = entity.primaryKey;

  if (!updateShape || !primaryKey) {
    return null;
  }

  const pkColumnSet = new Set(primaryKey.columns);
  let objBuilder = conjure.obj();

  // First, add PK fields as REQUIRED (from row shape to get correct types)
  for (const pkColName of primaryKey.columns) {
    // Find the field in the row shape (PK fields always exist in row)
    const pkField = entity.shapes.row.fields.find(f => f.name === pkColName);
    if (!pkField) continue;

    // Get the base type without optional/nullable modifiers for PK
    const mapping = fieldToArkType(
      { ...pkField, optional: false, nullable: false },
      enums,
    );

    if (mapping.kind === "enumRef") {
      const enumHandle = registry.import(`schema:arktype:${mapping.enumRef}`);
      objBuilder = objBuilder.prop(pkField.name, enumHandle.ref() as n.Expression);
    } else {
      objBuilder = objBuilder.prop(pkField.name, conjure.str(mapping.typeString));
    }
  }

  // Then add non-PK fields from update shape as OPTIONAL
  for (const field of updateShape.fields) {
    if (pkColumnSet.has(field.name)) {
      continue; // Skip PK fields, already added above
    }

    // Force optional for non-PK fields (partial updates)
    const mapping = fieldToArkType({ ...field, optional: true }, enums);

    if (mapping.kind === "enumRef") {
      const enumHandle = registry.import(`schema:arktype:${mapping.enumRef}`);
      let enumExpr = enumHandle.ref() as n.Expression;

      if (field.isArray) {
        enumExpr = conjure.chain(enumExpr).method("array").build();
      }
      if (field.nullable) {
        enumExpr = conjure.chain(enumExpr).method("or", [conjure.id("type").call([conjure.str("null")]).build()]).build();
      }
      // For optional enum fields, we need to use .optional() method
      enumExpr = conjure.chain(enumExpr).method("optional").build();

      objBuilder = objBuilder.prop(field.name, enumExpr);
    } else {
      objBuilder = objBuilder.prop(field.name, conjure.str(mapping.typeString));
    }
  }

  return conjure.id("type").call([objBuilder.build()]).build();
}

// =============================================================================
// ArkType Plugin Definition
// =============================================================================

/**
 * Get the UpdateInput schema name for an entity.
 * Convention: EntityNameUpdateInput (e.g., CommentUpdateInput)
 */
function getUpdateInputName(entity: TableEntity): string {
  return `${entity.name}UpdateInput`;
}

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
      baseEntityName,
    });
    declarations.push({
      name: insertName,
      capability: `schema:arktype:${insertName}:type`,
      baseEntityName,
    });
  }

  if (entity.shapes.update) {
    const updateName = entity.shapes.update.name;
    declarations.push({
      name: updateName,
      capability: `schema:arktype:${updateName}`,
      baseEntityName,
    });
    declarations.push({
      name: updateName,
      capability: `schema:arktype:${updateName}:type`,
      baseEntityName,
    });

    // UpdateInput schema: required PK + optional non-PK fields
    // Only declare if entity has both update shape AND primary key
    if (entity.primaryKey) {
      const updateInputName = getUpdateInputName(entity);
      declarations.push({
        name: updateInputName,
        capability: `schema:arktype:${updateInputName}`,
        baseEntityName,
      });
      declarations.push({
        name: updateInputName,
        capability: `schema:arktype:${updateInputName}:type`,
        baseEntityName,
      });
    }
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
      const registry = yield* SymbolRegistry;

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
            const capability = `schema:arktype:${shape.name}`;

            // Scope cross-references to this specific capability
            const schemaNode = registry.forSymbol(capability, () =>
              shapeToArkTypeObject(shape, enums, registry),
            );

            const schemaDecl = conjure.export.const(shape.name, schemaNode);

            rendered.push({
              name: shape.name,
              capability,
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

          // Render UpdateInput schema if entity has update shape AND primary key
          if (entity.shapes.update && entity.primaryKey) {
            const updateInputName = getUpdateInputName(entity);
            const capability = `schema:arktype:${updateInputName}`;

            const schemaNode = registry.forSymbol(capability, () =>
              buildUpdateInputSchema(entity, enums, registry),
            );

            if (schemaNode) {
              const schemaDecl = conjure.export.const(updateInputName, schemaNode);

              rendered.push({
                name: updateInputName,
                capability,
                node: schemaDecl,
                exports: "named",
                externalImports: [{ from: "arktype", names: ["type"] }],
                metadata: {
                  consume: createArkTypeConsumeCallback(updateInputName),
                },
              });

              if (resolvedConfig.exportTypes) {
                const inferType = conjure.ts.typeof(`${updateInputName}.infer`);
                const typeDecl = conjure.export.type(updateInputName, inferType);

                rendered.push({
                  name: updateInputName,
                  capability: `schema:arktype:${updateInputName}:type`,
                  node: typeDecl,
                  exports: "named",
                  externalImports: [{ from: "arktype", names: ["type"] }],
                });
              }
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
