/**
 * Effect Repos Plugin
 *
 * Generates Effect.Service wrappers around Model.makeRepository or query plugins
 * for table entities with single-column PKs.
 */
import { Effect } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { SymbolRegistry } from "../../runtime/registry.js";
import { IR } from "../../services/ir.js";
import { Inflection } from "../../services/inflection.js";
import { isTableEntity } from "../../ir/semantic-ir.js";
import type { EntityQueriesExtension } from "../../ir/extensions/queries.js";
import { conjure, cast } from "../../conjure/index.js";
import { hasSingleColumnPrimaryKey, getPrimaryKeyColumn, type ParsedEffectConfig } from "./shared.js";

const b = conjure.b;

/**
 * Effect Repos plugin - generates Effect.Service wrappers around Model.makeRepository
 * or query plugin exports.
 *
 * Output:
 * ```typescript
 * export class UserRepo extends Effect.Service<UserRepo>()("UserRepo", {
 *   effect: Effect.gen(function*() {
 *     const repo = yield* Model.makeRepository(User, {
 *       tableName: "app_public.users",
 *       spanPrefix: "UserRepo",
 *       idColumn: "id",
 *     })
 *     return { ...repo }
 *   }),
 *   dependencies: [SqlClient.SqlClient]
 * }) {}
 * ```
 */
export function effectRepos(config: ParsedEffectConfig): Plugin {
  const usesModelRepo = config.repoModel;

  const consumes = usesModelRepo ? ["effect:models"] : ["effect:models", "queries"];

  return {
    name: "effect-repos",

    provides: ["effect:repos"],

    consumes, // Need model classes to reference

    fileDefaults: [
      {
        pattern: "effect:repo:",
        fileNaming: ({ folderName }) => `${folderName}.ts`,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity) && hasSingleColumnPrimaryKey(entity)) {
          declarations.push({
            name: `${entity.name}Repo`,
            capability: `effect:repo:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity) && hasSingleColumnPrimaryKey(entity)) {
          const repoName = `${entity.name}Repo`;
          const capability = `effect:repo:${entity.name}`;

          // Scope cross-references (model import) to this specific capability
          const exportedClass = registry.forSymbol(capability, () => {
            let repoVarDecl: n.VariableDeclaration;

            if (usesModelRepo) {
              const qualifiedTableName = `${entity.schemaName}.${entity.pgName}`;
              const idColumn = getPrimaryKeyColumn(entity)!;

              // Get reference to the model class
              const modelHandle = registry.import(`effect:model:${entity.name}`);
              const modelRef = modelHandle.ref() as n.Expression;

              // Build: Model.makeRepository(Entity, { tableName, spanPrefix, idColumn })
              const makeRepoCall = conjure
                .id("Model")
                .method("makeRepository", [
                  modelRef,
                  conjure
                    .obj()
                    .prop("tableName", conjure.str(qualifiedTableName))
                    .prop("spanPrefix", conjure.str(repoName))
                    .prop("idColumn", conjure.str(idColumn))
                    .build(),
                ])
                .build();

              // Build: const repo = yield* Model.makeRepository(...)
              repoVarDecl = b.variableDeclaration("const", [
                b.variableDeclarator(
                  b.identifier("repo"),
                  b.yieldExpression(cast.toExpr(makeRepoCall), true), // true = delegate (yield*)
                ),
              ]);
            } else {
              const queriesHandle = registry.import(`queries:${entity.name}`);
              const queryMetadata = queriesHandle.metadata as EntityQueriesExtension | undefined;
              const properties: n.ObjectProperty[] = [];
              const seen = new Set<string>();
              const queryPrefix = inflection.variableName(entity.name, "");

              if (queryMetadata?.methods) {
                for (const method of queryMetadata.methods) {
                  const rawSuffix = method.name.startsWith(queryPrefix)
                    ? method.name.slice(queryPrefix.length)
                    : method.name;
                  const operation = rawSuffix.length > 0
                    ? rawSuffix[0]!.toLowerCase() + rawSuffix.slice(1)
                    : rawSuffix;
                  if (!operation) continue;

                  const queryCapability = `queries:${entity.name}:${operation}`;
                  if (!registry.has(queryCapability)) continue;

                  const queryRef = registry.import(queryCapability).ref() as n.Expression;

                  if (!seen.has(operation)) {
                    properties.push(b.objectProperty(b.identifier(operation), cast.toExpr(queryRef)));
                    seen.add(operation);
                  }

                  if (method.kind === "create" && !seen.has("insert")) {
                    properties.push(b.objectProperty(b.identifier("insert"), cast.toExpr(queryRef)));
                    seen.add("insert");
                  }
                }
              }

              const queriesObject = b.objectExpression(properties);
              repoVarDecl = b.variableDeclaration("const", [
                b.variableDeclarator(b.identifier("repo"), queriesObject),
              ]);
            }

            // Build: return { ...repo }
            const returnStmt = b.returnStatement(
              b.objectExpression([b.spreadElement(b.identifier("repo"))]),
            );

            // Build: function*() { const repo = yield* ...; return { ...repo } }
            const generatorFn = b.functionExpression(
              null,
              [],
              b.blockStatement([cast.toStmt(repoVarDecl), returnStmt]),
              true, // generator
            );

            // Build: Effect.gen(function*() { ... })
            const effectGenCall = conjure.id("Effect").method("gen", [generatorFn]).build();

            // Build: { effect: Effect.gen(...) }
            const serviceConfig = conjure.obj().prop("effect", effectGenCall).build();

            // Build: Effect.Service<RepoName>()
            const serviceRef = b.memberExpression(b.identifier("Effect"), b.identifier("Service"));
            const serviceWithType = b.callExpression(serviceRef, []);
            (serviceWithType as { typeParameters?: unknown }).typeParameters =
              b.tsTypeParameterInstantiation([b.tsTypeReference(b.identifier(repoName))]);

            // Build: Effect.Service<RepoName>()("RepoName", { ... })
            const serviceCall = b.callExpression(serviceWithType, [
              conjure.str(repoName),
              cast.toExpr(serviceConfig),
            ]);

            // Build: class RepoName extends Effect.Service<RepoName>()(...) {}
            const classDecl = b.classDeclaration(
              b.identifier(repoName),
              b.classBody([]),
              cast.toExpr(serviceCall),
            );

            return b.exportNamedDeclaration(classDecl, []);
          });

          rendered.push({
            name: repoName,
            capability,
            node: exportedClass,
            exports: "named",
            externalImports: usesModelRepo
              ? [
                  { from: "effect", names: ["Effect"] },
                  { from: "@effect/sql", names: ["Model"] },
                ]
              : [{ from: "effect", names: ["Effect"] }],
          });
        }
      }

      return rendered;
    }),
  };
}
