/**
 * Effect Repos Plugin
 *
 * Generates Effect.Service wrappers around Model.makeRepository or query plugins
 * for table entities with single-column PKs.
 */
import { Effect, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration } from "../../runtime/types.js";
import { SymbolRegistry, type SymbolRegistryService } from "../../runtime/registry.js";
import { Conjure } from "../../services/conjure.js";
import { IR } from "../../services/ir.js";
import { Inflection, type CoreInflection } from "../../services/inflection.js";
import { isTableEntity, type TableEntity } from "../../ir/semantic-ir.js";
import type { EntityQueriesExtension } from "../../ir/extensions/queries.js";
import { conjure, cast } from "../../conjure/index.js";
import {
  hasSingleColumnPrimaryKey,
  getPrimaryKeyColumn,
  type ParsedEffectConfig,
} from "./shared.js";

const b = conjure.b;

/**
 * Check if an entity is eligible for repo generation
 */
const isRepoEligible = (entity: TableEntity): boolean =>
  entity.permissions.canSelect &&
  entity.shapes.row.fields.length > 0 &&
  hasSingleColumnPrimaryKey(entity);

/**
 * Build Model.makeRepository based repo variable declaration
 */
const buildModelRepoDecl = (
  entity: TableEntity,
  repoName: string,
  registry: SymbolRegistryService,
): n.VariableDeclaration => {
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
  return b.variableDeclaration("const", [
    b.variableDeclarator(
      b.identifier("repo"),
      b.yieldExpression(cast.toExpr(makeRepoCall), true), // true = delegate (yield*)
    ),
  ]);
};

/**
 * Build query-based repo variable declaration
 */
const buildQueryRepoDecl = (
  entity: TableEntity,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): n.VariableDeclaration => {
  const queriesHandle = registry.import(`queries:${entity.name}`);
  const queryMetadata = queriesHandle.metadata as EntityQueriesExtension | undefined;
  const queryPrefix = inflection.variableName(entity.name, "");

  const properties = pipe(
    queryMetadata?.methods ?? [],
    methods =>
      methods.reduce(
        (acc, method) => {
          const rawSuffix = method.name.startsWith(queryPrefix)
            ? method.name.slice(queryPrefix.length)
            : method.name;
          const operation =
            rawSuffix.length > 0 ? rawSuffix[0]!.toLowerCase() + rawSuffix.slice(1) : rawSuffix;

          if (!operation) return acc;

          const queryCapability = `queries:${entity.name}:${operation}`;
          if (!registry.has(queryCapability)) return acc;

          const queryRef = registry.import(queryCapability).ref() as n.Expression;

          // Add operation property if not seen
          const withOp = acc.seen.has(operation)
            ? acc
            : {
                ...acc,
                props: [...acc.props, b.objectProperty(b.identifier(operation), cast.toExpr(queryRef))],
                seen: new Set([...acc.seen, operation]),
              };

          // Add insert alias for create operations
          if (method.kind === "create" && !withOp.seen.has("insert")) {
            return {
              ...withOp,
              props: [...withOp.props, b.objectProperty(b.identifier("insert"), cast.toExpr(queryRef))],
              seen: new Set([...withOp.seen, "insert"]),
            };
          }

          return withOp;
        },
        { props: [] as n.ObjectProperty[], seen: new Set<string>() },
      ),
    ({ props }) => props,
  );

  const queriesObject = b.objectExpression(properties);
  return b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier("repo"), queriesObject),
  ]);
};

/**
 * Build the repo service class declaration (without export)
 */
const buildRepoServiceClassDecl = (
  entity: TableEntity,
  repoName: string,
  usesModelRepo: boolean,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): n.ClassDeclaration => {
  const repoVarDecl = usesModelRepo
    ? buildModelRepoDecl(entity, repoName, registry)
    : buildQueryRepoDecl(entity, registry, inflection);

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
  return b.classDeclaration(
    b.identifier(repoName),
    b.classBody([]),
    cast.toExpr(serviceCall),
  );
};

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

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;
      const cj = yield* Conjure;

      const tables = [...ir.entities.values()].filter(isTableEntity).filter(isRepoEligible);

      const repoImports = usesModelRepo
        ? [
            { from: "effect", names: ["Effect"] },
            { from: "@effect/sql", names: ["Model"] },
          ]
        : [{ from: "effect", names: ["Effect"] }];

      return yield* Effect.forEach(tables, entity => {
        const repoName = `${entity.name}Repo`;
        const capability = `effect:repo:${entity.name}`;

        // Scope cross-references (model import) to this specific capability
        const classDecl = registry.forSymbol(capability, () =>
          buildRepoServiceClassDecl(entity, repoName, usesModelRepo, registry, inflection),
        );

        return cj.exp.class(repoName, classDecl, {
          capability,
          imports: repoImports,
          baseEntityName: entity.name,
        });
      });
    }),
  };
}
