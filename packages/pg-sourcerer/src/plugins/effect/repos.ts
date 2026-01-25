/**
 * Effect Repos Plugin
 *
 * Generates Effect.Service wrappers around Model.makeRepository for table entities with single-column PKs
 */
import { Effect } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { SymbolRegistry } from "../../runtime/registry.js";
import { IR } from "../../services/ir.js";
import { isTableEntity } from "../../ir/semantic-ir.js";
import { conjure, cast } from "../../conjure/index.js";
import { hasSingleColumnPrimaryKey, getPrimaryKeyColumn } from "./shared.js";

const b = conjure.b;

/**
 * Effect Repos plugin - generates Effect.Service wrappers around Model.makeRepository
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
export function effectRepos(): Plugin {
  return {
    name: "effect-repos",

    provides: ["effect:repos"],

    consumes: ["effect:models"], // Need model classes to reference

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

      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity) && hasSingleColumnPrimaryKey(entity)) {
          const repoName = `${entity.name}Repo`;
          const capability = `effect:repo:${entity.name}`;
          const qualifiedTableName = `${entity.schemaName}.${entity.pgName}`;
          const idColumn = getPrimaryKeyColumn(entity)!;

          // Scope cross-references (model import) to this specific capability
          const exportedClass = registry.forSymbol(capability, () => {
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
            const repoVarDecl = b.variableDeclaration("const", [
              b.variableDeclarator(
                b.identifier("repo"),
                b.yieldExpression(cast.toExpr(makeRepoCall), true), // true = delegate (yield*)
              ),
            ]);

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
            // Note: SqlClient dependency is not specified here since it doesn't have a Default layer.
            // Users provide SqlClient via Layer.provide when using the repo.
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
            externalImports: [
              { from: "effect", names: ["Effect"] },
              { from: "@effect/sql", names: ["Model"] },
            ],
          });
        }
      }

      return rendered;
    }),
  };
}
