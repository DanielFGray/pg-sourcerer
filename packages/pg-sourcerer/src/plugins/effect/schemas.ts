/**
 * Effect Schemas Plugin
 *
 * Generates Effect Schema unions for enum entities
 */
import { Effect } from "effect";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { IR } from "../../services/ir.js";
import { isEnumEntity, type EnumEntity } from "../../ir/semantic-ir.js";
import { conjure } from "../../conjure/index.js";
import type { ParsedEffectConfig } from "./shared.js";

/**
 * Build RenderedSymbol array for an enum entity
 */
const renderEnumSchema = (entity: EnumEntity, exportTypes: boolean): RenderedSymbol[] => {
  const literals = entity.values.map(v =>
    conjure.id("S").method("Literal", [conjure.str(v)]).build(),
  );

  const schemaNode = conjure.id("S").method("Union", literals).build();
  const schemaDecl = conjure.export.const(entity.name, schemaNode);

  const baseSymbol: RenderedSymbol = {
    name: entity.name,
    capability: `effect:schema:${entity.name}`,
    node: schemaDecl,
    exports: "named",
    imports: [{ from: "effect", names: ["Schema as S"] }],
  };

  if (!exportTypes) {
    return [baseSymbol];
  }

  const typeName = `${entity.name}Type`;
  const inferType = conjure.ts.qualifiedRefWithParams(
    ["S", "Schema", "Type"],
    [conjure.ts.typeof(entity.name)],
  );
  const typeDecl = conjure.export.type(typeName, inferType);

  const typeSymbol: RenderedSymbol = {
    name: typeName,
    capability: `effect:schema:${entity.name}:type`,
    node: typeDecl,
    exports: "named",
    imports: [{ from: "effect", names: ["Schema as S"] }],
  };

  return [baseSymbol, typeSymbol];
};

/**
 * Effect Schemas plugin - generates S.Union(S.Literal(...)) for enums
 */
export function effectSchemas(config: ParsedEffectConfig): Plugin {
  return {
    name: "effect-schemas",

    provides: ["effect:schemas"],

    fileDefaults: [
      {
        pattern: "effect:schema:",
        fileNaming: ({ folderName }) => `${folderName}.ts`,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      return [...ir.entities.values()].filter(isEnumEntity).map(
        (entity): SymbolDeclaration => ({
          name: entity.name,
          capability: `effect:schema:${entity.name}`,
          baseEntityName: entity.name,
        }),
      );
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;

      return [...ir.entities.values()]
        .filter(isEnumEntity)
        .flatMap(entity => renderEnumSchema(entity, config.exportTypes));
    }),
  };
}
