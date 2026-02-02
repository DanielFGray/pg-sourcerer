/**
 * Effect Models Plugin
 *
 * Generates Model.Class for table entities using @effect/sql
 */
import { Effect, Match, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../../runtime/types.js";
import { SymbolRegistry, type SymbolRegistryService } from "../../runtime/registry.js";
import { Conjure } from "../../services/conjure.js";
import { IR } from "../../services/ir.js";
import {
  isTableEntity,
  isEnumEntity,
  type TableEntity,
  type EnumEntity,
  type Field,
} from "../../ir/semantic-ir.js";
import { conjure, cast } from "../../conjure/index.js";
import { fieldToEffectMapping, isDbGenerated, getAutoTimestamp, toExpr } from "./shared.js";

const b = conjure.b;

const modelImports = [
  { from: "@effect/sql", names: ["Model"] },
  { from: "effect", names: ["Schema as S"] },
];

/**
 * Build the schema expression for a single field
 */
const buildFieldSchema = (
  field: Field,
  entity: TableEntity,
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.ObjectProperty => {
  // Check for auto-timestamp patterns first
  const autoTs = getAutoTimestamp(field);

  const schemaExpr = pipe(
    Match.value(autoTs),
    Match.when("insert", () => conjure.id("Model").prop("DateTimeInsertFromDate").build()),
    Match.when("update", () => conjure.id("Model").prop("DateTimeUpdateFromDate").build()),
    Match.orElse(() => {
      const mapping = fieldToEffectMapping(field, enums);

      const baseSchema = pipe(
        Match.value(mapping),
        Match.when({ kind: "enumRef" }, ({ enumRef }) => {
          const enumHandle = registry.import(`effect:schema:${enumRef}`);
          const enumValue = enumHandle.ref() as n.Expression;
          const withArray = field.isArray
            ? conjure.id("S").method("Array", [enumValue]).build()
            : enumValue;
          return field.nullable
            ? conjure.id("S").method("NullOr", [withArray]).build()
            : withArray;
        }),
        Match.when({ kind: "schema" }, ({ schema }) => schema),
        Match.exhaustive,
      );

      // Wrap in Model.Generated if field is auto-generated
      return isDbGenerated(field, entity)
        ? conjure.id("Model").method("Generated", [baseSchema]).build()
        : baseSchema;
    }),
  );

  return b.objectProperty(b.identifier(field.name), toExpr(schemaExpr));
};

function buildModelClassNode(
  entity: TableEntity,
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.ClassDeclaration {
  const entityName = entity.name;
  const tableName = entity.pgName;
  const shape = entity.shapes.row;

  const properties = shape.fields.map(field =>
    buildFieldSchema(field, entity, enums, registry),
  );

  const fieldsObj = b.objectExpression(properties);

  // Build: Model.Class<ClassName>("table_name")
  const modelClassRef = b.memberExpression(b.identifier("Model"), b.identifier("Class"));

  const modelClassWithType = b.callExpression(modelClassRef, [conjure.str(tableName)]);

  // Add type parameters: Model.Class<ClassName>
  (modelClassWithType as { typeParameters?: unknown }).typeParameters =
    b.tsTypeParameterInstantiation([b.tsTypeReference(b.identifier(entityName))]);

  // Call with fields: Model.Class<ClassName>("table_name")({ ... })
  const modelExpr = b.callExpression(modelClassWithType, [fieldsObj]);

  return b.classDeclaration(
    b.identifier(entityName),
    b.classBody([]),
    cast.toExpr(modelExpr),
  );
}

/**
 * Effect Models plugin - generates Model.Class for table entities
 */
export function effectModels(): Plugin {
  return {
    name: "effect-models",

    provides: ["effect:models"],

    consumes: ["effect:schemas"], // Need enum schemas for references

    fileDefaults: [
      {
        pattern: "effect:model:",
        fileNaming: ({ folderName }) => `${folderName}.ts`,
      },
    ],

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const cj = yield* Conjure;

      const enums = [...ir.entities.values()].filter(isEnumEntity);
      const tables = [...ir.entities.values()].filter(isTableEntity);

      return yield* Effect.forEach(tables, entity => {
        const capability = `effect:model:${entity.name}`;

        // Scope cross-references (enum imports) to this specific capability
        const classNode = registry.forSymbol(capability, () =>
          buildModelClassNode(entity, enums, registry),
        );

        return cj.exp.class(entity.name, classNode, {
          capability,
          imports: modelImports,
        });
      });
    }),
  };
}
