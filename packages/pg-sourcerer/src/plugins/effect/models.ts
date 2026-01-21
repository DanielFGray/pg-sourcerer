/**
 * Effect Models Plugin
 * 
 * Generates Model.Class for table entities using @effect/sql
 */
import { Effect } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { SymbolRegistry, type SymbolRegistryService } from "../../runtime/registry.js";
import { IR } from "../../services/ir.js";
import { isTableEntity, isEnumEntity, type TableEntity, type EnumEntity } from "../../ir/semantic-ir.js";
import { conjure, cast } from "../../conjure/index.js";
import {
  fieldToEffectMapping,
  isDbGenerated,
  getAutoTimestamp,
  toExpr,
} from "./shared.js";

const b = conjure.b;

function buildModelClass(
  entity: TableEntity,
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.Statement {
  const entityName = entity.name;
  const tableName = entity.pgName;
  const shape = entity.shapes.row;

  const properties = shape.fields.map(field => {
    // Check for auto-timestamp patterns first
    const autoTs = getAutoTimestamp(field);
    if (autoTs === "insert") {
      return b.objectProperty(
        b.identifier(field.name),
        toExpr(conjure.id("Model").prop("DateTimeInsertFromDate").build())
      );
    }
    if (autoTs === "update") {
      return b.objectProperty(
        b.identifier(field.name),
        toExpr(conjure.id("Model").prop("DateTimeUpdateFromDate").build())
      );
    }

    const mapping = fieldToEffectMapping(field, enums);

    let value: n.Expression;
    if (mapping.kind === "enumRef") {
      const enumHandle = registry.import(`effect:schema:${mapping.enumRef}`);
      value = enumHandle.ref() as n.Expression;

      // S.Array(elementType) - static method
      if (field.isArray) {
        value = conjure.id("S").method("Array", [value]).build();
      }
      if (field.nullable) {
        value = conjure.id("S").method("NullOr", [value]).build();
      }
    } else {
      value = mapping.schema;
    }

    // Wrap in Model.Generated if field is auto-generated
    if (isDbGenerated(field, entity)) {
      value = conjure.id("Model").method("Generated", [value]).build();
    }

    return b.objectProperty(b.identifier(field.name), toExpr(value));
  });

  const fieldsObj = b.objectExpression(properties);

  // Build: Model.Class<ClassName>("table_name")
  const modelClassRef = b.memberExpression(
    b.identifier("Model"),
    b.identifier("Class")
  );

  const modelClassWithType = b.callExpression(modelClassRef, [
    conjure.str(tableName),
  ]);

  // Add type parameters: Model.Class<ClassName>
  (modelClassWithType as { typeParameters?: unknown }).typeParameters =
    b.tsTypeParameterInstantiation([
      b.tsTypeReference(b.identifier(entityName)),
    ]);

  // Call with fields: Model.Class<ClassName>("table_name")({ ... })
  const modelExpr = b.callExpression(modelClassWithType, [fieldsObj]);

  const classDecl = b.classDeclaration(
    b.identifier(entityName),
    b.classBody([]),
    cast.toExpr(modelExpr),
  );

  return b.exportNamedDeclaration(classDecl, []);
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

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          declarations.push({
            name: entity.name,
            capability: `effect:model:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;

      const enums = [...ir.entities.values()].filter(isEnumEntity);
      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          const classDecl = buildModelClass(entity, enums, registry);

          rendered.push({
            name: entity.name,
            capability: `effect:model:${entity.name}`,
            node: classDecl,
            exports: "named",
            externalImports: [
              { from: "@effect/sql", names: ["Model"] },
              { from: "effect", names: ["Schema as S"] },
            ],
          });
        }
      }

      return rendered;
    }),
  };
}
