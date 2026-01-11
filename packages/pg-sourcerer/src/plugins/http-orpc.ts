/**
 * HTTP oRPC Plugin - Generate oRPC routers from query plugins
 *
 * Consumes method symbols from sql-queries or kysely-queries via the symbol registry
 * and generates type-safe oRPC procedures using @orpc/server.
 *
 * Uses oRPC's `type()` utility for simple params (type-only, no runtime validation)
 * and imports body schemas from whatever plugin provides the "schemas" capability
 * (zod, arktype, valibot, etc.) for runtime validation.
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";
import type { MethodSymbol } from "../services/symbols.js";
import type { QueryMethodParam } from "../ir/extensions/queries.js";

const { b } = conjure;

// ============================================================================
// Configuration Schema
// ============================================================================

const HttpOrpcConfigSchema = S.Struct({
  /** Output directory for generated router files. Default: "orpc" */
  outputDir: S.optionalWith(S.String, { default: () => "orpc" }),

  /**
   * Header content to prepend to each generated file.
   * MUST import `os` from @orpc/server.
   *
   * @example
   * ```typescript
   * header: `import { os } from "@orpc/server";`
   * ```
   */
  header: S.String,

  /** Name of the aggregated router export. Default: "appRouter" */
  aggregatorName: S.optionalWith(S.String, { default: () => "appRouter" }),
});

/** Input config type (with optional fields) */
export type HttpOrpcConfig = S.Schema.Encoded<typeof HttpOrpcConfigSchema>;

// ============================================================================
// Type String Builders (for oRPC type<>() utility)
// ============================================================================

/**
 * Convert a QueryMethodParam to a TypeScript type string for use in type<>().
 */
const paramToTypeString = (param: QueryMethodParam): string => {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  let tsType: string;
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      tsType = "number";
      break;
    case "boolean":
    case "bool":
      tsType = "boolean";
      break;
    case "date":
      tsType = "Date";
      break;
    case "string":
    default:
      tsType = "string";
      break;
  }

  // Handle arrays
  if (param.type.endsWith("[]")) {
    tsType = `${tsType}[]`;
  }

  // Handle optionality
  if (!param.required) {
    tsType = `${tsType} | undefined`;
  }

  return tsType;
};

/**
 * Build a TypeScript object type literal string for type<>().
 * Returns something like "{ id: number; name?: string }"
 */
const buildTypeObjectString = (params: readonly QueryMethodParam[]): string => {
  if (params.length === 0) return "{}";

  const fields = params.map((param) => {
    const typeStr = paramToTypeString(param);
    const optional = !param.required ? "?" : "";
    return `${param.name}${optional}: ${typeStr.replace(" | undefined", "")}`;
  });

  return `{ ${fields.join("; ")} }`;
};

// ============================================================================
// Procedure Builders
// ============================================================================

/**
 * Build the handler function body for a procedure.
 * oRPC handlers receive { input, context } and return data directly.
 */
const buildProcedureBody = (queryFnName: string, method: MethodSymbol): n.Statement[] => {
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
 * Build Zod type expression for a param.
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
 * Build a single oRPC procedure.
 * Returns: os.input(type<InputType>()).handler(async ({ input }) => { ... })
 * Or for body schemas: os.input(BodySchema).handler(...)
 */
const buildProcedure = (
  method: MethodSymbol,
  entityName: string,
  queryFnName: string,
): {
  procedureExpr: n.Expression;
  bodySchema: SchemaImport | null;
  needsType: boolean;
  needsZMerge: boolean;
} => {
  const bodySchema = getBodySchemaImport(method, entityName);
  let needsType = false;
  let needsZMerge = false;

  let chainExpr: n.Expression = b.identifier("os");

  if (method.params.length > 0) {
    let inputSchema: n.Expression;

    // Check for non-body params (PK, FK, lookup, pagination)
    const nonBodyParams = method.params.filter(p => p.source !== "body");
    const callSig = method.callSignature ?? { style: "named" as const };

    if (bodySchema && nonBodyParams.length > 0 && callSig.bodyStyle === "property") {
      // For update-style operations with bodyStyle: "property", we need to merge
      // the PK/FK params with the body schema: z.object({ id: z.number() }).merge(PostUpdate)
      needsZMerge = true;
      // Build: z.object({ id: z.coerce.number() })
      let objBuilder = conjure.obj();
      for (const p of nonBodyParams) {
        objBuilder = objBuilder.prop(p.name, buildZodParamType(p));
      }
      const zodObject = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("object")),
        [cast.toExpr(objBuilder.build())],
      );
      // Build: z.object({ id: ... }).merge(PostUpdate)
      inputSchema = b.callExpression(
        b.memberExpression(zodObject, b.identifier("merge")),
        [b.identifier(bodySchema.schemaName)],
      );
    } else if (bodySchema) {
      inputSchema = b.identifier(bodySchema.schemaName);
    } else {
      needsType = true;
      const typeStr = buildTypeObjectString(method.params);
      inputSchema = b.identifier(`type<${typeStr}>()`);
    }

    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("input")),
      [cast.toExpr(inputSchema)],
    );
  }

  const handlerParams: n.ObjectProperty[] = [];
  if (method.params.length > 0) {
    const inputProp = b.objectProperty(b.identifier("input"), b.identifier("input"));
    inputProp.shorthand = true;
    handlerParams.push(inputProp);
  }

  const handlerBody = buildProcedureBody(queryFnName, method);
  const handler = b.arrowFunctionExpression(
    [b.objectPattern(handlerParams)],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  chainExpr = b.callExpression(
    b.memberExpression(cast.toExpr(chainExpr), b.identifier("handler")),
    [handler],
  );

  return { procedureExpr: chainExpr, bodySchema, needsType, needsZMerge };
};

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Create an http-orpc provider that generates oRPC routers.
 *
 * @example
 * ```typescript
 * import { httpOrpc } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     zod(),
 *     sqlQueries(),
 *     httpOrpc({
 *       header: `import { os } from "@orpc/server";`,
 *     }),
 *   ],
 * })
 * ```
 */
export function httpOrpc(config: HttpOrpcConfig): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(HttpOrpcConfigSchema)(config);

  return definePlugin({
    name: "http-orpc",
    kind: "http-routes",
    singleton: true,

    canProvide: () => true,

    requires: () => [
      { kind: "queries", params: {} },
      { kind: "schemas", params: {} },
    ],

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext): void => {
      const { outputDir, header, aggregatorName } = parsed;

      // Get all entities with registered query methods
      const entityNames = ctx.symbols.getEntitiesWithMethods();

      if (entityNames.length === 0) {
        return;
      }

      // Track generated routers for aggregator
      const generatedRouters: Array<{ fileName: string; routerName: string }> = [];

      // Generate router for each entity
      for (const entityName of entityNames) {
        const entityMethods = ctx.symbols.getEntityMethods(entityName);
        if (!entityMethods || entityMethods.methods.length === 0) continue;

        const filePath = `${outputDir}/${inflect.uncapitalize(entityName)}.ts`;
        const routerName = `${inflect.uncapitalize(entityName)}Router`;

        const file = ctx.file(filePath);

        // Header provides os import
        file.header(header);

        const queriesImportPath = `../${entityMethods.importPath.replace(/\.ts$/, ".js")}`;
        file.import({
          kind: "relative",
          namespace: "Queries",
          from: queriesImportPath,
        });

        const bodySchemaImports: SchemaImport[] = [];
        let fileNeedsType = false;
        let fileNeedsZod = false;
        let routerObjBuilder = conjure.obj();

        for (const method of entityMethods.methods) {
          const queryFnName = `Queries.${method.name}`;
          const { procedureExpr, bodySchema, needsType, needsZMerge } = buildProcedure(method, entityName, queryFnName);

          if (bodySchema) bodySchemaImports.push(bodySchema);
          if (needsType) fileNeedsType = true;
          if (needsZMerge) fileNeedsZod = true;

          routerObjBuilder = routerObjBuilder.prop(method.name, procedureExpr);
        }

        // Import type utility if needed
        if (fileNeedsType) {
          file.import({ kind: "package", names: ["type"], from: "@orpc/server" });
        }

        // Import zod if needed for merged schemas
        if (fileNeedsZod) {
          file.import({ kind: "package", names: ["z"], from: "zod" });
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

        const routerExport = conjure.export.const(routerName, routerObjBuilder.build());

        // Emit router export
        file.ast(conjure.program(routerExport)).emit();

        generatedRouters.push({
          fileName: `${inflect.uncapitalize(entityName)}.js`,
          routerName,
        });
      }

      // Generate aggregator index.ts
      if (generatedRouters.length > 0) {
        const indexPath = `${outputDir}/index.ts`;
        const indexFile = ctx.file(indexPath);

        // Header provides os import
        indexFile.header(header);

        for (const route of generatedRouters) {
          indexFile.import({
            kind: "relative",
            names: [route.routerName],
            from: `./${route.fileName}`,
          });
        }

        // Build: export const appRouter = { user: userRouter, ... }
        let routerObjBuilder = conjure.obj();
        for (const route of generatedRouters) {
          const key = route.routerName.replace(/Router$/, "");
          routerObjBuilder = routerObjBuilder.prop(key, b.identifier(route.routerName));
        }

        const routerExport = conjure.export.const(aggregatorName, routerObjBuilder.build());

        // Also export the type
        const typeExport = b.exportNamedDeclaration(
          b.tsTypeAliasDeclaration(
            b.identifier("AppRouter"),
            b.tsTypeQuery(b.identifier(aggregatorName)),
          ),
        );

        indexFile.ast(conjure.program(routerExport, typeExport)).emit();
      }
    },
  });
}
