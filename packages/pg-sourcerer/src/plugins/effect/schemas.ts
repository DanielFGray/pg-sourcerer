/**
 * Effect Schemas Plugin
 * 
 * Generates Effect Schema unions for enum entities
 */
import { Effect } from "effect";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { IR } from "../../services/ir.js";
import { isEnumEntity } from "../../ir/semantic-ir.js";
import { conjure } from "../../conjure/index.js";
import type { ParsedEffectConfig } from "./shared.js";

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

      const declarations: SymbolDeclaration[] = [];

      for (const entity of ir.entities.values()) {
        if (isEnumEntity(entity)) {
          declarations.push({
            name: entity.name,
            capability: `effect:schema:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;

      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isEnumEntity(entity)) {
          const literals = entity.values.map(v =>
            conjure.id("S").method("Literal", [conjure.str(v)]).build()
          );

          const schemaNode = conjure.id("S")
            .method("Union", literals)
            .build();

          const schemaDecl = conjure.export.const(entity.name, schemaNode);

          rendered.push({
            name: entity.name,
            capability: `effect:schema:${entity.name}`,
            node: schemaDecl,
            exports: "named",
            externalImports: [
              { from: "effect", names: ["Schema as S"] },
            ],
          });

          // Optionally export inferred type with "Type" suffix to avoid collision
          if (config.exportTypes) {
            const typeName = `${entity.name}Type`;
            const inferType = conjure.ts.qualifiedRefWithParams(
              ["S", "Schema", "Type"],
              [conjure.ts.typeof(entity.name)],
            );
            const typeDecl = conjure.export.type(typeName, inferType);

            rendered.push({
              name: typeName,
              capability: `effect:schema:${entity.name}:type`,
              node: typeDecl,
              exports: "named",
              externalImports: [{ from: "effect", names: ["Schema as S"] }],
            });
          }
        }
      }

      return rendered;
    }),
  };
}
