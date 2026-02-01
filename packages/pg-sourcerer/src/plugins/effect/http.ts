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
import type { ExternalImport } from "../../runtime/emit.js";
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

/**
 * Check if entity is eligible for HTTP API generation
 */
const isHttpEligible = (entity: TableEntity): boolean =>
  entity.tags.omit !== true && hasSingleColumnPrimaryKey(entity);

// =============================================================================
// PK Schema Type Detection
// =============================================================================

/**
 * Get the Effect Schema type for the primary key (for path params).
 */
function getPrimaryKeySchemaType(entity: TableEntity): string {
  const pkColumn = entity.primaryKey?.columns[0];
  const pkField = pkColumn
    ? entity.shapes.row.fields.find(f => f.columnName === pkColumn)
    : undefined;
  const pgType = pkField?.pgAttribute.getType();
  const typeName = pgType?.typname.toLowerCase();

  if (!typeName) return "S.String";
  if (typeName === "uuid") return "S.UUID";
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
  return parts.length === 2
    ? b.memberExpression(b.identifier(parts[0]!), b.identifier(parts[1]!))
    : b.identifier(schemaType);
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
 * Build the base HttpApiEndpoint expression based on path configuration.
 */
const buildBaseEndpoint = (
  method: "get" | "post" | "put" | "del",
  name: string,
  path: string | null,
  pathParam?: { name: string; schema: n.Expression },
): n.Expression => {
  // Template literal path with param: HttpApiEndpoint.get("findById")`/${HttpApiSchema.param("id", S.UUID)}`
  if (pathParam) {
    const paramCall = b.callExpression(
      b.memberExpression(b.identifier("HttpApiSchema"), b.identifier("param")),
      [conjure.str(pathParam.name), cast.toExpr(pathParam.schema)],
    );

    const baseCall = b.callExpression(
      b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
      [conjure.str(name)],
    );

    return b.taggedTemplateExpression(
      baseCall,
      b.templateLiteral(
        [
          b.templateElement({ raw: "/", cooked: "/" }, false),
          b.templateElement({ raw: "", cooked: "" }, true),
        ],
        [paramCall],
      ),
    );
  }

  // Simple path: HttpApiEndpoint.post("create", "/")
  if (path !== null) {
    return b.callExpression(
      b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
      [conjure.str(name), conjure.str(path)],
    );
  }

  // No path provided
  return b.callExpression(
    b.memberExpression(b.identifier("HttpApiEndpoint"), b.identifier(method)),
    [conjure.str(name)],
  );
};

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
  const baseEndpoint = buildBaseEndpoint(method, name, path, options.pathParam);

  // Chain modifiers using ternary expressions
  const withPayload = options.payload
    ? b.callExpression(
        b.memberExpression(cast.toExpr(baseEndpoint), b.identifier("setPayload")),
        [cast.toExpr(options.payload)],
      )
    : baseEndpoint;

  const withSuccess = options.success
    ? b.callExpression(
        b.memberExpression(cast.toExpr(withPayload), b.identifier("addSuccess")),
        options.successStatus
          ? [
              cast.toExpr(options.success),
              cast.toExpr(
                conjure.obj().prop("status", b.numericLiteral(options.successStatus)).build(),
              ),
            ]
          : [cast.toExpr(options.success)],
      )
    : withPayload;

  return options.error
    ? b.callExpression(
        b.memberExpression(cast.toExpr(withSuccess), b.identifier("addError")),
        [
          b.identifier(options.error.name),
          conjure.obj().prop("status", b.numericLiteral(options.error.status)).build(),
        ],
      )
    : withSuccess;
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
  const endpoints = [
    buildEndpoint("get", "findById", null, {
      pathParam: { name: "id", schema: pkSchemaExpr },
      success: modelRef,
      error: { name: errorName, status: 404 },
    }),
    buildEndpoint("post", "insert", "/", {
      payload: modelInsert,
      success: modelRef,
      successStatus: 201,
    }),
    buildEndpoint("put", "update", null, {
      pathParam: { name: "id", schema: pkSchemaExpr },
      payload: modelUpdate,
      success: modelRef,
      error: { name: errorName, status: 404 },
    }),
    buildEndpoint("del", "delete", null, {
      pathParam: { name: "id", schema: pkSchemaExpr },
      error: { name: errorName, status: 404 },
    }),
  ];

  // Build: HttpApiGroup.make("routePath").prefix("/basePath/routePath").add(...).add(...)
  const baseGroup = b.callExpression(
    b.memberExpression(b.identifier("HttpApiGroup"), b.identifier("make")),
    [conjure.str(routePath.replace(/^\//, ""))], // Remove leading slash for group name
  );

  const withPrefix = b.callExpression(
    b.memberExpression(cast.toExpr(baseGroup), b.identifier("prefix")),
    [conjure.str(fullPath)],
  );

  // Chain all endpoints using reduce
  const groupExpr = endpoints.reduce(
    (acc, endpoint) =>
      b.callExpression(b.memberExpression(cast.toExpr(acc), b.identifier("add")), [
        cast.toExpr(endpoint),
      ]),
    withPrefix as n.Expression,
  );

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
  const apiExpr = b.callExpression(
    b.memberExpression(
      b.callExpression(
        b.memberExpression(b.identifier("HttpApi"), b.identifier("make")),
        [conjure.str(apiName)],
      ),
      b.identifier("add"),
    ),
    [b.identifier(groupName)],
  );

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
 * Build a handler definition { name, handler } for chaining
 */
interface HandlerDef {
  name: string;
  handler: n.ArrowFunctionExpression;
}

/**
 * Build handler definitions for CRUD operations
 */
function buildHandlerDefs(entityName: string): HandlerDef[] {
  const errorName = `${entityName}NotFound`;

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

  // .handle("insert", ({ payload }) => repo.insert(payload))
  const insertHandler = b.arrowFunctionExpression(
    [b.objectPattern([shorthandProp("payload")])],
    b.callExpression(b.memberExpression(b.identifier("repo"), b.identifier("insert")), [
      b.identifier("payload"),
    ]),
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

  return [
    { name: "findById", handler: findByIdHandler },
    { name: "insert", handler: insertHandler },
    { name: "update", handler: updateHandler },
    { name: "delete", handler: deleteHandler },
  ];
}

/**
 * Generate handlers using repo methods.
 */
function buildHandlers(entityName: string, inflection: CoreInflection): n.Statement {
  const handlersName = `${entityName}ApiGroupLive`;
  const apiName = `${entityName}Api`;
  const repoName = `${entityName}Repo`;
  const routePath = inflection.entityRoutePath(entityName).replace(/^\//, "");

  // Build repo declaration: const repo = yield* EntityRepo;
  const repoDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier("repo"), b.yieldExpression(b.identifier(repoName), true)),
  ]);

  // Build handlers chain using reduce
  const handlerDefs = buildHandlerDefs(entityName);
  const handlersChain = handlerDefs.reduce(
    (acc, { name, handler }) =>
      b.callExpression(b.memberExpression(cast.toExpr(acc), b.identifier("handle")), [
        conjure.str(name),
        handler,
      ]),
    b.identifier("handlers") as n.Expression,
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
  const pipeArgs = [
    layerProvideApis,
    ...(sqlLayerName
      ? [
          b.callExpression(b.memberExpression(b.identifier("Layer"), b.identifier("provide")), [
            b.identifier(sqlLayerName),
          ]),
        ]
      : []),
    withLogAddress,
  ];

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
 * Build symbol declarations for a single entity
 */
const declareEntitySymbols = (entityName: string): SymbolDeclaration[] => {
  const suffixes = ["NotFound", "ApiGroup", "Api", "ApiGroupLive", "ApiLive"] as const;
  return suffixes.map(suffix => ({
    name: `${entityName}${suffix}`,
    capability: `effect:http:${entityName}:${suffix}`,
    baseEntityName: entityName,
  }));
};

/**
 * Scope imports for a capability suffix
 */
const scopeImportsForSuffix = (
  registry: SymbolRegistryService,
  entityName: string,
  capSuffix: string,
): void => {
  const capability = `effect:http:${entityName}:${capSuffix}`;
  registry.forSymbol(capability, () => {
    // Import model and repo - only ApiGroupLive handlers actually need them
    if (capSuffix === "ApiGroupLive") {
      registry.import(`effect:model:${entityName}`).ref();
      registry.import(`effect:repo:${entityName}`).ref();
    }
    // ApiGroup references the Model for schema types
    if (capSuffix === "ApiGroup") {
      registry.import(`effect:model:${entityName}`).ref();
    }
    // ApiLive needs handlers and repo
    if (capSuffix === "ApiLive") {
      registry.import(`effect:http:${entityName}:ApiGroupLive`).ref();
      registry.import(`effect:repo:${entityName}`).ref();
    }
  });
};

/**
 * Effect HTTP plugin - generates @effect/platform HttpApi endpoints.
 */
export function effectHttp(config: ParsedEffectConfig): Plugin {
  const httpConfig = config.http as ParsedHttpConfig;

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

      const eligibleEntities = [...ir.entities.values()].filter(isTableEntity).filter(isHttpEligible);

      const entityDeclarations = eligibleEntities.flatMap(entity => declareEntitySymbols(entity.name));

      // Add server aggregator if there are any entities
      return entityDeclarations.length > 0
        ? [...entityDeclarations, { name: "ServerLive", capability: "effect:http:server" }]
        : entityDeclarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const eligibleEntities = [...ir.entities.values()].filter(isTableEntity).filter(isHttpEligible);

      // Render entity HTTP symbols
      const entitySymbols = eligibleEntities.flatMap(entity => {
        const namedStatements = generateEntityHttpStatements(entity, httpConfig, inflection);

        return namedStatements.map(({ name, capSuffix, node }): RenderedSymbol => {
          const capability = `effect:http:${entity.name}:${capSuffix}`;

          // Scope import tracking to this specific capability
          scopeImportsForSuffix(registry, entity.name, capSuffix);

          return {
            name,
            capability,
            node,
            exports: "named",
            imports: [platformImports, effectImports],
          };
        });
      });

      // Generate server aggregator if there are entities
      if (eligibleEntities.length === 0) {
        return entitySymbols;
      }

      const entityNames = eligibleEntities.map(e => e.name);
      const sqlLayerName = httpConfig.sqlClientLayer?.named?.[0];
      const serverStatements = generateServerStatements(entityNames, sqlLayerName);

      // Scope import tracking to the server capability
      registry.forSymbol("effect:http:server", () => {
        entityNames.forEach(name => {
          registry.import(`effect:http:${name}:ApiLive`).ref();
        });
      });

      const serverUserImports: readonly UserModuleRef[] | undefined = httpConfig.sqlClientLayer
        ? [httpConfig.sqlClientLayer]
        : undefined;

      const serverSymbols = serverStatements.map(
        (stmt): RenderedSymbol => ({
          name: "ServerLive",
          capability: "effect:http:server",
          node: stmt,
          exports: "named",
          imports: [
            { from: "@effect/platform", names: ["HttpApiBuilder", "HttpServer"] },
            { from: "effect", names: ["Layer"] },
          ],
          userImports: serverUserImports,
        }),
      );

      return [...entitySymbols, ...serverSymbols];
    }),
  };
}
