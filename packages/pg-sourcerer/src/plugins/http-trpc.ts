/**
 * HTTP tRPC Plugin - Generate tRPC routers from query plugins
 *
 * Consumes method symbols from sql-queries or kysely-queries via the symbol registry
 * and generates type-safe tRPC routers with schema validation.
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";
import type { MethodSymbol } from "../services/symbols.js";
import type { QueryMethodKind, QueryMethodParam } from "../ir/extensions/queries.js";
import {
  SCHEMA_BUILDER_KIND,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";

const { b } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const HttpTrpcConfigSchema = S.Struct({
  /** Output directory for generated router files. Default: "trpc" */
  outputDir: S.optionalWith(S.String, { default: () => "trpc" }),

  /**
   * Header content to prepend to each generated file.
   * MUST import `router` and a base procedure (e.g., `publicProcedure`).
   *
   * @example
   * ```typescript
   * header: `import { router, publicProcedure } from "../trpc.js";`
   * ```
   */
  header: S.String,

  /**
   * Name of the base procedure to use in generated code.
   * Must match an import from your header.
   * Default: "publicProcedure"
   */
  baseProcedure: S.optionalWith(S.String, { default: () => "publicProcedure" }),

  /** Name of the aggregated router export. Default: "appRouter" */
  aggregatorName: S.optionalWith(S.String, { default: () => "appRouter" }),
});

/** Input config type (with optional fields) */
export type HttpTrpcConfig = S.Schema.Encoded<typeof HttpTrpcConfigSchema>;

// ============================================================================
// String Helpers
// ============================================================================

/** Convert PascalCase/camelCase to kebab-case */
const toKebabCase = (str: string): string =>
  str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

// ============================================================================
// Procedure Builders
// ============================================================================

/**
 * Map query method kind to tRPC procedure type.
 */
const kindToProcedureType = (kind: QueryMethodKind): "query" | "mutation" => {
  switch (kind) {
    case "read":
    case "list":
    case "lookup":
      return "query";
    case "create":
    case "update":
    case "delete":
    case "function":
      return "mutation";
  }
};

/**
 * Build the handler function body for a procedure.
 * tRPC handlers receive { input, ctx } and return data directly.
 */
const buildProcedureBody = (method: MethodSymbol): n.Statement[] => {
  const queryFnName = method.name;
  const callSig = method.callSignature ?? { style: "named" as const };
  const statements: n.Statement[] = [];

  // Build the function call arguments based on callSignature
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    // Positional: fn(a, b, c)
    for (const param of method.params) {
      args.push(b.memberExpression(b.identifier("input"), b.identifier(param.name)));
    }
  } else {
    // Named: fn({ a, b, c }) or fn(input) for body
    const bodyParam = method.params.find((p) => p.source === "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn(input)
      args.push(b.identifier("input"));
    } else if (bodyParam && callSig.bodyStyle === "property") {
      // Body wrapped in property: fn({ id, data })
      // Collect non-body params that need to be extracted from input
      const nonBodyParams = method.params.filter(
        (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup" || p.source === "pagination",
      );

      if (nonBodyParams.length > 0) {
        // Generate: const { id, ...data } = input;
        const destructureProps: n.Property[] = nonBodyParams.map((p) =>
          b.property.from({ kind: "init", key: b.identifier(p.name), value: b.identifier(p.name), shorthand: true }),
        );
        const restId = b.identifier(bodyParam.name);
        const restElem = b.restElement(restId);
        const pattern = b.objectPattern([...destructureProps, restElem]);
        const destructureDecl = b.variableDeclaration("const", [
          b.variableDeclarator(pattern, b.identifier("input")),
        ]);
        statements.push(destructureDecl);

        // Build: { id, data } using the destructured variables
        let objBuilder = conjure.obj();
        for (const param of nonBodyParams) {
          objBuilder = objBuilder.shorthand(param.name);
        }
        objBuilder = objBuilder.shorthand(bodyParam.name);
        args.push(objBuilder.build());
      } else {
        // No non-body params, just wrap input: fn({ data: input })
        args.push(conjure.obj().prop(bodyParam.name, b.identifier("input")).build());
      }
    } else if (method.params.length > 0) {
      // Simple named params: fn(input) since input matches the shape
      args.push(b.identifier("input"));
    }
  }

  // Build: return await queryFn(args)
  const queryCall = b.callExpression(b.identifier(queryFnName), args.map(cast.toExpr));
  const awaitExpr = b.awaitExpression(queryCall);

  // For delete, return success object
  if (method.kind === "delete") {
    statements.push(b.expressionStatement(awaitExpr));
    statements.push(b.returnStatement(conjure.obj().prop("success", b.booleanLiteral(true)).build()));
    return statements;
  }

  statements.push(b.returnStatement(awaitExpr));
  return statements;
};

/** Schema import info needed for body validation */
interface SchemaImport {
  readonly entity: string;
  readonly shape: "insert" | "update";
  readonly schemaName: string;
}

/**
 * Determine if a method needs body validation and which schema to use.
 */
const getBodySchemaImport = (method: MethodSymbol, entityName: string): SchemaImport | null => {
  if (method.kind === "create") {
    return { entity: entityName, shape: "insert", schemaName: `${entityName}Insert` };
  }
  if (method.kind === "update") {
    return { entity: entityName, shape: "update", schemaName: `${entityName}Update` };
  }
  return null;
};

/**
 * Function type for requesting schema builder results.
 */
type SchemaBuilderFn = (params: readonly QueryMethodParam[]) => SchemaBuilderResult | undefined;

/**
 * Build the input schema expression for a procedure.
 */
const buildInputSchema = (
  method: MethodSymbol,
  entityName: string,
  requestSchema: SchemaBuilderFn,
): {
  inputExpr: n.Expression | null;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaBuilderResult["importSpec"] | null;
} => {
  const bodySchema = getBodySchemaImport(method, entityName);
  const nonBodyParams = method.params.filter((p) => p.source !== "body");
  const callSig = method.callSignature ?? { style: "named" as const };

  // For update with bodyStyle: "property", we need to merge PK params with body schema
  if (bodySchema && nonBodyParams.length > 0 && callSig.bodyStyle === "property") {
    // Build: z.object({ id: z.coerce.number() }).merge(PostUpdate)
    let objBuilder = conjure.obj();
    for (const p of nonBodyParams) {
      objBuilder = objBuilder.prop(p.name, buildZodParamType(p));
    }
    const zodObject = b.callExpression(
      b.memberExpression(b.identifier("z"), b.identifier("object")),
      [cast.toExpr(objBuilder.build())],
    );
    const mergedSchema = b.callExpression(
      b.memberExpression(zodObject, b.identifier("merge")),
      [b.identifier(bodySchema.schemaName)],
    );
    return {
      inputExpr: mergedSchema,
      bodySchema,
      schemaBuilderImport: { names: ["z"], from: "zod" },
    };
  }

  // Body params only use imported entity schemas
  if (bodySchema) {
    return {
      inputExpr: b.identifier(bodySchema.schemaName),
      bodySchema,
      schemaBuilderImport: null,
    };
  }

  // Non-body params: use schema builder
  if (nonBodyParams.length === 0) {
    return { inputExpr: null, bodySchema: null, schemaBuilderImport: null };
  }

  const schemaResult = requestSchema(nonBodyParams);
  if (schemaResult) {
    return {
      inputExpr: schemaResult.ast,
      bodySchema: null,
      schemaBuilderImport: schemaResult.importSpec,
    };
  }

  // Fallback: build inline z.object (tRPC requires Zod)
  let objBuilder = conjure.obj();
  for (const param of nonBodyParams) {
    const zodType = buildZodParamType(param);
    objBuilder = objBuilder.prop(param.name, zodType);
  }

  return {
    inputExpr: b.callExpression(
      b.memberExpression(b.identifier("z"), b.identifier("object")),
      [cast.toExpr(objBuilder.build())],
    ),
    bodySchema: null,
    schemaBuilderImport: { names: ["z"], from: "zod" },
  };
};

/**
 * Build Zod type expression for a param (fallback when no schema-builder).
 */
const buildZodParamType = (param: QueryMethodParam): n.Expression => {
  const baseType = param.type.toLowerCase();

  let zodCall: n.Expression;
  switch (baseType) {
    case "number":
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("number"),
        ),
        [],
      );
      break;
    case "boolean":
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("boolean")),
        [],
      );
      break;
    case "date":
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("date"),
        ),
        [],
      );
      break;
    case "string":
    default:
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("string")),
        [],
      );
      break;
  }

  if (!param.required) {
    zodCall = b.callExpression(
      b.memberExpression(cast.toExpr(zodCall), b.identifier("optional")),
      [],
    );
  }

  return zodCall;
};

/**
 * Build a single tRPC procedure.
 */
const buildProcedure = (
  method: MethodSymbol,
  entityName: string,
  baseProcedure: string,
  requestSchema: SchemaBuilderFn,
): {
  procedureExpr: n.Expression;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaBuilderResult["importSpec"] | null;
} => {
  const procedureType = kindToProcedureType(method.kind);

  // Start with base procedure
  let chainExpr: n.Expression = b.identifier(baseProcedure);

  // Build input schema
  const { inputExpr, bodySchema, schemaBuilderImport } = buildInputSchema(
    method,
    entityName,
    requestSchema,
  );

  // Add .input(schema) if there are params
  if (inputExpr) {
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("input")),
      [cast.toExpr(inputExpr)],
    );
  }

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] = [];
  if (method.params.length > 0) {
    const inputProp = b.objectProperty(b.identifier("input"), b.identifier("input"));
    inputProp.shorthand = true;
    handlerParams.push(inputProp);
  }

  const handlerBody = buildProcedureBody(method);
  const handler = b.arrowFunctionExpression(
    [b.objectPattern(handlerParams)],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  // Add .query() or .mutation()
  chainExpr = b.callExpression(
    b.memberExpression(cast.toExpr(chainExpr), b.identifier(procedureType)),
    [handler],
  );

  return { procedureExpr: chainExpr, bodySchema, schemaBuilderImport };
};

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Create an http-trpc provider that generates tRPC routers.
 *
 * @example
 * ```typescript
 * import { httpTrpc } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     zod(),
 *     sqlQueries(),
 *     httpTrpc({
 *       header: `import { router, publicProcedure } from "../trpc.js";`,
 *     }),
 *   ],
 * })
 * ```
 */
export function httpTrpc(config: HttpTrpcConfig): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(HttpTrpcConfigSchema)(config);

  return definePlugin({
    name: "http-trpc",
    kind: "http-routes",
    singleton: true,

    canProvide: () => true,

    requires: () => [
      { kind: "queries", params: {} },
      { kind: "schemas", params: {} },
    ],

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext): void => {
      const { outputDir, baseProcedure, header, aggregatorName } = parsed;

      // Get all entities with registered query methods
      const entityNames = ctx.symbols.getEntitiesWithMethods();

      if (entityNames.length === 0) {
        return;
      }

      // Track generated routers for aggregator
      const generatedRouters: Array<{ fileName: string; routerName: string }> = [];

      // Create schema builder function
      const requestSchema: SchemaBuilderFn = (params) => {
        if (params.length === 0) return undefined;
        try {
          const request: SchemaBuilderRequest = { variant: "params", params };
          return ctx.request<SchemaBuilderResult | undefined>(SCHEMA_BUILDER_KIND, request);
        } catch {
          return undefined;
        }
      };

      // Generate router for each entity
      for (const entityName of entityNames) {
        const entityMethods = ctx.symbols.getEntityMethods(entityName);
        if (!entityMethods || entityMethods.methods.length === 0) continue;

        const filePath = `${outputDir}/${inflect.uncapitalize(entityName)}.ts`;
        const routerName = `${inflect.uncapitalize(entityName)}Router`;

        const file = ctx.file(filePath);

        // Header provides router and baseProcedure imports
        file.header(header);

        // Import query functions
        const queryFunctionNames = entityMethods.methods.map((m) => m.name);
        const queriesImportPath = `../${entityMethods.importPath.replace(/\.ts$/, ".js")}`;
        file.import({
          kind: "relative",
          names: queryFunctionNames,
          from: queriesImportPath,
        });

        // Build router object
        let routerObjBuilder = conjure.obj();
        const bodySchemaImports: SchemaImport[] = [];
        let schemaLibraryImport: SchemaBuilderResult["importSpec"] | null = null;

        for (const method of entityMethods.methods) {
          const { procedureExpr, bodySchema, schemaBuilderImport } = buildProcedure(
            method,
            entityName,
            baseProcedure,
            requestSchema,
          );

          if (bodySchema) bodySchemaImports.push(bodySchema);
          if (schemaBuilderImport) schemaLibraryImport = schemaBuilderImport;

          routerObjBuilder = routerObjBuilder.prop(method.name, procedureExpr);
        }

        // Import schema library if needed
        if (schemaLibraryImport) {
          if (schemaLibraryImport.names) {
            file.import({
              kind: "package",
              names: [...schemaLibraryImport.names],
              from: schemaLibraryImport.from,
            });
          }
        }

        // Import body schemas
        for (const schemaImport of bodySchemaImports) {
          file.import({
            kind: "symbol",
            ref: {
              capability: "schemas",
              entity: schemaImport.entity,
              shape: schemaImport.shape,
            },
          });
        }

        // Build: export const userRouter = router({ ... })
        const routerCall = b.callExpression(
          b.identifier("router"),
          [cast.toExpr(routerObjBuilder.build())],
        );
        const exportStmt = conjure.export.const(routerName, routerCall);
        file.ast(conjure.program(exportStmt)).emit();

        generatedRouters.push({
          fileName: `${inflect.uncapitalize(entityName)}.js`,
          routerName,
        });
      }

      // Generate aggregator index.ts
      if (generatedRouters.length > 0) {
        const indexPath = `${outputDir}/index.ts`;
        const indexFile = ctx.file(indexPath);

        // Header provides router import
        indexFile.header(header);

        for (const route of generatedRouters) {
          indexFile.import({
            kind: "relative",
            names: [route.routerName],
            from: `./${route.fileName}`,
          });
        }

        // Build: export const appRouter = router({ user: userRouter, ... })
        let routerObjBuilder = conjure.obj();
        for (const route of generatedRouters) {
          const key = route.routerName.replace(/Router$/, "");
          routerObjBuilder = routerObjBuilder.prop(key, b.identifier(route.routerName));
        }

        const routerCall = b.callExpression(
          b.identifier("router"),
          [cast.toExpr(routerObjBuilder.build())],
        );
        const exportStmt = conjure.export.const(aggregatorName, routerCall);

        // Also export the type
        const typeExport = b.exportNamedDeclaration(
          b.tsTypeAliasDeclaration(
            b.identifier("AppRouter"),
            b.tsTypeQuery(b.identifier(aggregatorName)),
          ),
        );

        indexFile.ast(conjure.program(exportStmt, typeExport)).emit();
      }
    },
  });
}
