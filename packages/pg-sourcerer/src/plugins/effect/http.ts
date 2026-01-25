/**
 * Effect HTTP Plugin
 *
 * Generates @effect/platform HttpApi endpoints for entities with repos.
 *
 * For each entity, generates:
 * - NotFound error class
 * - ApiGroup with CRUD endpoints (findById, insert, update, delete)
 * - Api wrapper
 * - Handlers using repo methods
 * - ApiLive layer combining everything
 *
 * Also generates a Server.ts aggregator file.
 */
import { Effect } from "effect";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../../runtime/types.js";
import { SymbolRegistry, type SymbolRegistryService } from "../../runtime/registry.js";
import { IR } from "../../services/ir.js";
import { Inflection, type CoreInflection } from "../../services/inflection.js";
import { isTableEntity, type TableEntity } from "../../ir/semantic-ir.js";
import { conjure, cast } from "../../conjure/index.js";
import type { ExternalImport, RenderedSymbolWithImports } from "../../runtime/emit.js";
import type { UserModuleRef } from "../../user-module.js";
import {
  type ParsedEffectConfig,
  type ParsedHttpConfig,
  hasSingleColumnPrimaryKey,
  getPrimaryKeyColumn,
  toExpr,
} from "./shared.js";
import { PG_NUMBER_TYPES } from "../shared/pg-types.js";

const b = conjure.b;

// =============================================================================
// PK Schema Type Detection
// =============================================================================

/**
 * Get the Effect Schema type for the primary key (for path params).
 */
function getPrimaryKeySchemaType(entity: TableEntity): string {
  const pkColumn = entity.primaryKey?.columns[0];
  if (!pkColumn) return "S.String";

  const pkField = entity.shapes.row.fields.find(f => f.columnName === pkColumn);
  if (!pkField) return "S.String";

  const pgType = pkField.pgAttribute.getType();
  if (!pgType) return "S.String";

  const typeName = pgType.typname.toLowerCase();

  // UUID
  if (typeName === "uuid") {
    return "S.UUID";
  }

  // Numeric types need NumberFromString for URL parsing
  if (PG_NUMBER_TYPES.has(typeName) || typeName === "serial" || typeName === "bigserial") {
    return "S.NumberFromString";
  }

  return "S.String";
}

/**
 * Build the schema expression for a PK type.
 * Returns S.UUID, S.NumberFromString, or S.String.
 */
function buildPkSchemaExpr(schemaType: string): n.Expression {
  const parts = schemaType.split(".");
  if (parts.length === 2) {
    return b.memberExpression(b.identifier(parts[0]!), b.identifier(parts[1]!));
  }
  return b.identifier(schemaType);
}

// =============================================================================
// AST Builders for HTTP Components
// =============================================================================

/**
 * Generate NotFound error class:
 * export class {Entity}NotFound extends S.TaggedError<{Entity}NotFound>()("{Entity}NotFound", { id: Schema }) {}
 */
function buildNotFoundError(entityName: string, pkSchemaType: string): n.Statement {
  const errorName = `${entityName}NotFound`;
  const pkSchemaExpr = buildPkSchemaExpr(pkSchemaType);

  // Build: S.TaggedError<ErrorName>()("ErrorName", { id: Schema })
  const taggedErrorRef = b.memberExpression(b.identifier("S"), b.identifier("TaggedError"));

  // Add type parameter: S.TaggedError<ErrorName>
  const taggedErrorWithType = b.callExpression(taggedErrorRef, []);
  (taggedErrorWithType as { typeParameters?: unknown }).typeParameters =
    b.tsTypeParameterInstantiation([b.tsTypeReference(b.identifier(errorName))]);

  // Call with args: ("ErrorName", { id: Schema })
  const taggedErrorCall = b.callExpression(taggedErrorWithType, [
    conjure.str(errorName),
    conjure.obj().prop("id", pkSchemaExpr).build(),
  ]);

  // Build class: class ErrorName extends S.TaggedError<ErrorName>()(...) {}
  const classDecl = b.classDeclaration(
    b.identifier(errorName),
    b.classBody([]),
    taggedErrorCall as ExpressionKind,
  );

  return b.exportNamedDeclaration(classDecl, []);
}

/**
 * Build an HttpApiEndpoint expression.
 */
function buildEndpoint(
  method: "get" | "post" | "put" | "del",
  name: string,
  path: string | null,
  options: {
    pathParam?: { name: string; schema: n.Expression };
    payload?: n.Expression;
    success?: n.Expression;
    successStatus?: number;
    error?: { name: string; status: number };
  },
): n.Expression {
  // Start with HttpApiEndpoint.{method}("name", "/path") or HttpApiEndpoint.{method}("name")
  let endpoint: n.Expression;

  if (path !== null && !options.pathParam) {
    // Simple path: HttpApiEndpoint.post("create", "/")
    endpoint = b.callExpression(
      b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
      [conjure.str(name), conjure.str(path)],
    );
  } else if (options.pathParam) {
    // Template literal path with param: HttpApiEndpoint.get("findById")`/${HttpApiSchema.param("id", S.UUID)}`
    const paramCall = b.callExpression(
      b.memberExpression(b.identifier("HttpApiSchema"), b.identifier("param")),
      [conjure.str(options.pathParam.name), cast.toExpr(options.pathParam.schema)],
    );

    const baseCall = b.callExpression(
      b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
      [conjure.str(name)],
    );

    endpoint = b.taggedTemplateExpression(
      baseCall,
      b.templateLiteral(
        [
          b.templateElement({ raw: "/", cooked: "/" }, false),
          b.templateElement({ raw: "", cooked: "" }, true),
        ],
        [paramCall],
      ),
    );
  } else {
    // No path provided
    endpoint = b.callExpression(
      b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
      [conjure.str(name)],
    );
  }

  // Add payload if specified
  if (options.payload) {
    endpoint = b.callExpression(
      b.memberExpression(cast.toExpr(endpoint), b.identifier("setPayload")),
      [cast.toExpr(options.payload)],
    );
  }

  // Add success if specified
  if (options.success) {
    const successArgs: ExpressionKind[] = [cast.toExpr(options.success)];
    if (options.successStatus) {
      successArgs.push(
        cast.toExpr(conjure.obj().prop("status", b.numericLiteral(options.successStatus)).build()),
      );
    }
    endpoint = b.callExpression(
      b.memberExpression(cast.toExpr(endpoint), b.identifier("addSuccess")),
      successArgs,
    );
  }

  // Add error if specified
  if (options.error) {
    endpoint = b.callExpression(
      b.memberExpression(cast.toExpr(endpoint), b.identifier("addError")),
      [
        b.identifier(options.error.name),
        conjure.obj().prop("status", b.numericLiteral(options.error.status)).build(),
      ],
    );
  }

  return endpoint;
}

/**
 * Generate HttpApiGroup with CRUD endpoints.
 */
function buildApiGroup(
  entityName: string,
  pkSchemaType: string,
  basePath: string,
  inflection: CoreInflection,
): n.Statement {
  const groupName = `${entityName}ApiGroup`;
  const errorName = `${entityName}NotFound`;
  const routePath = inflection.entityRoutePath(entityName);
  const fullPath = `${basePath}${routePath}`;
  const pkSchemaExpr = buildPkSchemaExpr(pkSchemaType);

  // Model schema references
  const modelRef = b.identifier(entityName);
  const modelInsert = b.memberExpression(modelRef, b.identifier("insert"));
  const modelUpdate = b.memberExpression(modelRef, b.identifier("update"));

  // Build endpoints
  const findByIdEndpoint = buildEndpoint("get", "findById", null, {
    pathParam: { name: "id", schema: pkSchemaExpr },
    success: modelRef,
    error: { name: errorName, status: 404 },
  });

  const insertEndpoint = buildEndpoint("post", "insert", "/", {
    payload: modelInsert,
    success: modelRef,
    successStatus: 201,
  });

  const updateEndpoint = buildEndpoint("put", "update", null, {
    pathParam: { name: "id", schema: pkSchemaExpr },
    payload: modelUpdate,
    success: modelRef,
    error: { name: errorName, status: 404 },
  });

  const deleteEndpoint = buildEndpoint("del", "delete", null, {
    pathParam: { name: "id", schema: pkSchemaExpr },
    error: { name: errorName, status: 404 },
  });

  // Build: HttpApiGroup.make("routePath").prefix("/basePath/routePath").add(...).add(...)
  let groupExpr: n.Expression = b.callExpression(
    b.memberExpression(b.identifier("HttpApiGroup"), b.identifier("make")),
    [conjure.str(routePath.replace(/^\//, ""))], // Remove leading slash for group name
  );

  groupExpr = b.callExpression(b.memberExpression(cast.toExpr(groupExpr), b.identifier("prefix")), [
    conjure.str(fullPath),
  ]);

  // Add endpoints
  for (const endpoint of [findByIdEndpoint, insertEndpoint, updateEndpoint, deleteEndpoint]) {
    groupExpr = b.callExpression(b.memberExpression(cast.toExpr(groupExpr), b.identifier("add")), [
      cast.toExpr(endpoint),
    ]);
  }

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier(groupName), cast.toExpr(groupExpr)),
  ]);

  return b.exportNamedDeclaration(varDecl, []);
}

/**
 * Generate HttpApi wrapper.
 */
function buildApi(entityName: string): n.Statement {
  const apiName = `${entityName}Api`;
  const groupName = `${entityName}ApiGroup`;

  // Build: HttpApi.make("EntityApi").add(EntityApiGroup)
  let apiExpr: n.Expression = b.callExpression(
    b.memberExpression(b.identifier("HttpApi"), b.identifier("make")),
    [conjure.str(apiName)],
  );

  apiExpr = b.callExpression(b.memberExpression(cast.toExpr(apiExpr), b.identifier("add")), [
    b.identifier(groupName),
  ]);

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier(apiName), cast.toExpr(apiExpr)),
  ]);

  return b.exportNamedDeclaration(varDecl, []);
}

/**
 * Build a shorthand property: { id } instead of { id: id }
 */
function shorthandProp(name: string): n.Property {
  const prop = b.property("init", b.identifier(name), b.identifier(name));
  prop.shorthand = true;
  return prop;
}

/**
 * Generate handlers using repo methods.
 */
function buildHandlers(entityName: string, inflection: CoreInflection): n.Statement {
  const handlersName = `${entityName}ApiGroupLive`;
  const apiName = `${entityName}Api`;
  const repoName = `${entityName}Repo`;
  const errorName = `${entityName}NotFound`;
  const routePath = inflection.entityRoutePath(entityName).replace(/^\//, "");

  // Build repo declaration: const repo = yield* EntityRepo;
  const repoDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier("repo"), b.yieldExpression(b.identifier(repoName), true)),
  ]);

  // Build handlers chain
  let handlersChain: n.Expression = b.identifier("handlers");

  // .handle("findById", ({ path: { id } }) => repo.findById(id).pipe(Effect.flatMap(Option.match({...}))))
  const findByIdHandler = b.arrowFunctionExpression(
    [
      b.objectPattern([
        b.property("init", b.identifier("path"), b.objectPattern([shorthandProp("id")])),
      ]),
    ],
    b.callExpression(
      b.memberExpression(
        b.callExpression(b.memberExpression(b.identifier("repo"), b.identifier("findById")), [
          b.identifier("id"),
        ]),
        b.identifier("pipe"),
      ),
      [
        b.callExpression(b.memberExpression(b.identifier("Effect"), b.identifier("flatMap")), [
          b.callExpression(b.memberExpression(b.identifier("Option"), b.identifier("match")), [
            conjure
              .obj()
              .prop(
                "onNone",
                b.arrowFunctionExpression(
                  [],
                  b.callExpression(
                    b.memberExpression(b.identifier("Effect"), b.identifier("fail")),
                    [
                      b.newExpression(b.identifier(errorName), [
                        conjure.obj().prop("id", b.identifier("id")).build(),
                      ]),
                    ],
                  ),
                ),
              )
              .prop("onSome", b.memberExpression(b.identifier("Effect"), b.identifier("succeed")))
              .build(),
          ]),
        ]),
      ],
    ),
  );

  handlersChain = b.callExpression(
    b.memberExpression(cast.toExpr(handlersChain), b.identifier("handle")),
    [conjure.str("findById"), findByIdHandler],
  );

  // .handle("insert", ({ payload }) => repo.insert(payload))
  const insertHandler = b.arrowFunctionExpression(
    [b.objectPattern([shorthandProp("payload")])],
    b.callExpression(b.memberExpression(b.identifier("repo"), b.identifier("insert")), [
      b.identifier("payload"),
    ]),
  );

  handlersChain = b.callExpression(
    b.memberExpression(cast.toExpr(handlersChain), b.identifier("handle")),
    [conjure.str("insert"), insertHandler],
  );

  // .handle("update", ({ path: { id }, payload }) => repo.update({ ...payload, id }))
  const updateHandler = b.arrowFunctionExpression(
    [
      b.objectPattern([
        b.property("init", b.identifier("path"), b.objectPattern([shorthandProp("id")])),
        shorthandProp("payload"),
      ]),
    ],
    b.callExpression(b.memberExpression(b.identifier("repo"), b.identifier("update")), [
      b.objectExpression([b.spreadElement(b.identifier("payload")), shorthandProp("id")]),
    ]),
  );

  handlersChain = b.callExpression(
    b.memberExpression(cast.toExpr(handlersChain), b.identifier("handle")),
    [conjure.str("update"), updateHandler],
  );

  // .handle("delete", ({ path: { id } }) => repo.delete(id))
  const deleteHandler = b.arrowFunctionExpression(
    [
      b.objectPattern([
        b.property("init", b.identifier("path"), b.objectPattern([shorthandProp("id")])),
      ]),
    ],
    b.callExpression(b.memberExpression(b.identifier("repo"), b.identifier("delete")), [
      b.identifier("id"),
    ]),
  );

  handlersChain = b.callExpression(
    b.memberExpression(cast.toExpr(handlersChain), b.identifier("handle")),
    [conjure.str("delete"), deleteHandler],
  );

  // Build return statement
  const returnStmt = b.returnStatement(cast.toExpr(handlersChain));

  // Build generator function body
  const genBody = b.blockStatement([repoDecl, returnStmt]);

  // Build: function*() { ... }
  const genFunc = b.functionExpression(null, [], genBody);
  genFunc.generator = true;

  // Build: Effect.gen(function*() { ... })
  const effectGen = b.callExpression(
    b.memberExpression(b.identifier("Effect"), b.identifier("gen")),
    [genFunc],
  );

  // Build: (handlers) => Effect.gen(...)
  const handlersCallback = b.arrowFunctionExpression([b.identifier("handlers")], effectGen);

  // Build: HttpApiBuilder.group(Api, "routePath", callback)
  const groupCall = b.callExpression(
    b.memberExpression(b.identifier("HttpApiBuilder"), b.identifier("group")),
    [b.identifier(apiName), conjure.str(routePath), handlersCallback],
  );

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier(handlersName), cast.toExpr(groupCall)),
  ]);

  return b.exportNamedDeclaration(varDecl, []);
}

/**
 * Generate ApiLive layer.
 */
function buildApiLive(entityName: string): n.Statement {
  const apiLiveName = `${entityName}ApiLive`;
  const apiName = `${entityName}Api`;
  const handlersName = `${entityName}ApiGroupLive`;
  const repoName = `${entityName}Repo`;

  // Build: HttpApiBuilder.api(Api).pipe(
  //   Layer.provide(HandlersLive),
  //   Layer.provide(Repo.Default),
  // )
  const apiBuilder = b.callExpression(
    b.memberExpression(b.identifier("HttpApiBuilder"), b.identifier("api")),
    [b.identifier(apiName)],
  );

  const layerProvideHandlers = b.callExpression(
    b.memberExpression(b.identifier("Layer"), b.identifier("provide")),
    [b.identifier(handlersName)],
  );

  const layerProvideRepo = b.callExpression(
    b.memberExpression(b.identifier("Layer"), b.identifier("provide")),
    [b.memberExpression(b.identifier(repoName), b.identifier("Default"))],
  );

  const apiLiveExpr = b.callExpression(
    b.memberExpression(cast.toExpr(apiBuilder), b.identifier("pipe")),
    [layerProvideHandlers, layerProvideRepo],
  );

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier(apiLiveName), cast.toExpr(apiLiveExpr)),
  ]);

  return b.exportNamedDeclaration(varDecl, []);
}

/**
 * A named statement for rendering with its capability suffix.
 */
interface NamedStatement {
  name: string;
  /** Capability suffix (e.g., "NotFound", "ApiGroup") */
  capSuffix: string;
  node: n.Statement;
}

/**
 * Generate all statements for an entity's HTTP API file.
 */
function generateEntityHttpStatements(
  entity: TableEntity,
  config: ParsedHttpConfig,
  inflection: CoreInflection,
): NamedStatement[] {
  const pkSchemaType = getPrimaryKeySchemaType(entity);
  const basePath = config.basePath;

  return [
    {
      name: `${entity.name}NotFound`,
      capSuffix: "NotFound",
      node: buildNotFoundError(entity.name, pkSchemaType),
    },
    {
      name: `${entity.name}ApiGroup`,
      capSuffix: "ApiGroup",
      node: buildApiGroup(entity.name, pkSchemaType, basePath, inflection),
    },
    { name: `${entity.name}Api`, capSuffix: "Api", node: buildApi(entity.name) },
    {
      name: `${entity.name}ApiGroupLive`,
      capSuffix: "ApiGroupLive",
      node: buildHandlers(entity.name, inflection),
    },
    { name: `${entity.name}ApiLive`, capSuffix: "ApiLive", node: buildApiLive(entity.name) },
  ];
}

/**
 * Generate Server.ts aggregator file.
 *
 * @param entityNames - Names of entities with HTTP APIs
 * @param sqlLayerName - Optional name of the SqlClient layer to provide
 */
function generateServerStatements(
  entityNames: readonly string[],
  sqlLayerName?: string,
): n.Statement[] {
  // Build: HttpApiBuilder.serve().pipe(
  //   Layer.provide([UserApiLive, PostApiLive, ...]),
  //   Layer.provide(SqlLive),  // if sqlClientLayer configured
  //   HttpServer.withLogAddress,
  // )
  const serveCall = b.callExpression(
    b.memberExpression(b.identifier("HttpApiBuilder"), b.identifier("serve")),
    [],
  );

  const apiLiveArray = b.arrayExpression(entityNames.map(name => b.identifier(`${name}ApiLive`)));

  const layerProvideApis = b.callExpression(
    b.memberExpression(b.identifier("Layer"), b.identifier("provide")),
    [apiLiveArray],
  );

  const withLogAddress = b.memberExpression(
    b.identifier("HttpServer"),
    b.identifier("withLogAddress"),
  );

  // Build pipe args: [Layer.provide([...ApiLive]), Layer.provide(SqlLive)?, HttpServer.withLogAddress]
  const pipeArgs: n.Expression[] = [layerProvideApis];

  if (sqlLayerName) {
    const layerProvideSql = b.callExpression(
      b.memberExpression(b.identifier("Layer"), b.identifier("provide")),
      [b.identifier(sqlLayerName)],
    );
    pipeArgs.push(cast.toExpr(layerProvideSql));
  }

  pipeArgs.push(withLogAddress);

  const serverLiveExpr = b.callExpression(
    b.memberExpression(cast.toExpr(serveCall), b.identifier("pipe")),
    pipeArgs.map(cast.toExpr),
  );

  const varDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier("ServerLive"), cast.toExpr(serverLiveExpr)),
  ]);

  return [b.exportNamedDeclaration(varDecl, [])];
}

// =============================================================================
// Plugin Definition
// =============================================================================

/**
 * Effect HTTP plugin - generates @effect/platform HttpApi endpoints.
 */
export function effectHttp(config: ParsedEffectConfig): Plugin {
  const httpConfig = config.http as ParsedHttpConfig;

  return {
    name: "effect-http",

    provides: ["effect:http"],

    consumes: ["effect:models", "effect:repos"],

    fileDefaults: [
      // Server aggregator uses serverFile config
      {
        pattern: "effect:http:server",
        fileNaming: httpConfig.serverFile,
      },
      // Entity HTTP code goes in the same file as model/repo
      {
        pattern: "effect:http:",
        fileNaming: ({ folderName }) => `${folderName}.ts`,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;
        if (entity.tags.omit === true) continue;
        if (!hasSingleColumnPrimaryKey(entity)) continue;

        // Declare all 5 symbols for each entity's HTTP API
        // Each needs a unique capability so they can be rendered separately
        declarations.push({
          name: `${entity.name}NotFound`,
          capability: `effect:http:${entity.name}:NotFound`,
          baseEntityName: entity.name,
        });
        declarations.push({
          name: `${entity.name}ApiGroup`,
          capability: `effect:http:${entity.name}:ApiGroup`,
          baseEntityName: entity.name,
        });
        declarations.push({
          name: `${entity.name}Api`,
          capability: `effect:http:${entity.name}:Api`,
          baseEntityName: entity.name,
        });
        declarations.push({
          name: `${entity.name}ApiGroupLive`,
          capability: `effect:http:${entity.name}:ApiGroupLive`,
          baseEntityName: entity.name,
        });
        declarations.push({
          name: `${entity.name}ApiLive`,
          capability: `effect:http:${entity.name}:ApiLive`,
          baseEntityName: entity.name,
        });
      }

      // Declare server aggregator if there are any entities
      if (declarations.length > 0) {
        declarations.push({
          name: "ServerLive",
          capability: "effect:http:server",
        });
      }

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const rendered: RenderedSymbol[] = [];
      const entityNames: string[] = [];

      const platformImports: ExternalImport = {
        from: "@effect/platform",
        names: [
          "HttpApi",
          "HttpApiBuilder",
          "HttpApiEndpoint",
          "HttpApiGroup",
          "HttpApiSchema",
          "HttpServer",
        ],
      };

      const effectImports: ExternalImport = {
        from: "effect",
        names: ["Effect", "Layer", "Option", "Schema as S"],
      };

      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;
        if (entity.tags.omit === true) continue;
        if (!hasSingleColumnPrimaryKey(entity)) continue;

        entityNames.push(entity.name);

        const namedStatements = generateEntityHttpStatements(entity, httpConfig, inflection);

        // Render all statements - each gets its own capability so they can be matched
        // to their declarations. Use forSymbol() to scope imports to each specific capability.
        for (const { name, capSuffix, node } of namedStatements) {
          const capability = `effect:http:${entity.name}:${capSuffix}`;

          // Scope import tracking to this specific capability
          registry.forSymbol(capability, () => {
            // Import model and repo - only ApiGroupLive handlers actually need them
            if (capSuffix === "ApiGroupLive") {
              registry.import(`effect:model:${entity.name}`).ref();
              registry.import(`effect:repo:${entity.name}`).ref();
            }
            // ApiGroup references the Model for schema types
            if (capSuffix === "ApiGroup") {
              registry.import(`effect:model:${entity.name}`).ref();
            }
            // ApiLive needs handlers and repo
            if (capSuffix === "ApiLive") {
              registry.import(`effect:http:${entity.name}:ApiGroupLive`).ref();
              registry.import(`effect:repo:${entity.name}`).ref();
            }
          });

          rendered.push({
            name,
            capability,
            node,
            exports: "named", // Node already has export, wrapWithExport will detect and skip
            externalImports: [platformImports, effectImports],
          });
        }
      }

      // Generate server aggregator
      if (entityNames.length > 0) {
        // Get the first named import from sqlClientLayer config (if any)
        const sqlLayerName = httpConfig.sqlClientLayer?.named?.[0];
        const serverStatements = generateServerStatements(entityNames, sqlLayerName);

        // Scope import tracking to the server capability
        registry.forSymbol("effect:http:server", () => {
          // Import only ApiLive layers (not models or repos)
          for (const name of entityNames) {
            registry.import(`effect:http:${name}:ApiLive`).ref();
          }
        });

        // User module imports for SqlClient layer (if configured)
        const serverUserImports: readonly UserModuleRef[] | undefined = httpConfig.sqlClientLayer
          ? [httpConfig.sqlClientLayer]
          : undefined;

        for (const stmt of serverStatements) {
          const serverSymbol: RenderedSymbolWithImports = {
            name: "ServerLive",
            capability: "effect:http:server",
            node: stmt,
            exports: "named", // Node already has export, wrapWithExport will detect and skip
            externalImports: [
              { from: "@effect/platform", names: ["HttpApiBuilder", "HttpServer"] },
              { from: "effect", names: ["Layer"] },
            ],
            userImports: serverUserImports,
          };
          rendered.push(serverSymbol);
        }
      }

      return rendered;
    }),
  };
}
