/**
 * Effect Schemas Plugin
 *
 * Generates Effect Schema unions for enum entities
 */
import { Effect } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../../runtime/types.js";
import { IR } from "../../services/ir.js";
import { Conjure } from "../../services/conjure.js";
import { isEnumEntity, type EnumEntity } from "../../ir/semantic-ir.js";
import { conjure } from "../../conjure/index.js";
import type { ParsedEffectConfig } from "./shared.js";

const effectSchemaImports = [{ from: "effect", names: ["Schema as S"] }];

/**
 * Build the enum schema expression: S.Union(S.Literal("a"), S.Literal("b"), ...)
 */
const buildEnumSchemaExpr = (entity: EnumEntity): n.Expression => {
  const literals = entity.values.map(v =>
    conjure.id("S").method("Literal", [conjure.str(v)]).build(),
  );
  return conjure.id("S").method("Union", literals).build();
};

/**
 * Build the inferred type: S.Schema.Type<typeof EnumName>
 */
const buildInferredType = (entityName: string): n.TSType =>
  conjure.ts.qualifiedRefWithParams(
    ["S", "Schema", "Type"],
    [conjure.ts.typeof(entityName)],
  );

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

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const cj = yield* Conjure;

      const enums = [...ir.entities.values()].filter(isEnumEntity);

      // Generate schema constants for all enums
      const schemaStmts = yield* Effect.forEach(enums, entity =>
        cj.exp.const(entity.name, buildEnumSchemaExpr(entity), {
          capability: `effect:schema:${entity.name}`,
          imports: effectSchemaImports,
          baseEntityName: entity.name,
        }),
      );

      // Optionally generate type aliases
      if (!config.exportTypes) {
        return schemaStmts;
      }

      const typeStmts = yield* Effect.forEach(enums, entity =>
        cj.exp.type(`${entity.name}Type`, buildInferredType(entity.name), {
          capability: `effect:schema:${entity.name}:type`,
          imports: effectSchemaImports,
          baseEntityName: entity.name,
        }),
      );

      return [...schemaStmts, ...typeStmts];
    }),
  };
}
