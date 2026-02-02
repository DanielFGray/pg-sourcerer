import type { namedTypes as n } from "ast-types";
import { Match, Predicate } from "effect";

import type { EntityPermissions, TableEntity } from "../../ir/semantic-ir.js";
import { isTableEntity } from "../../ir/semantic-ir.js";
import type { SemanticIR } from "../../ir/semantic-ir.js";
import type { SchemaImportSpec } from "../../ir/extensions/schema-builder.js";
import {
  QueryMethodKind,
  type QueryMethod,
  type QueryMethodParam,
  type EntityQueriesExtension,
} from "../../ir/extensions/queries.js";
import type { ExternalImport } from "../../runtime/emit.js";
import type { SymbolHandle, SymbolDeclaration } from "../../runtime/types.js";
import type { SymbolRegistryService } from "../../runtime/registry.js";
import type { CoreInflection } from "../../services/inflection.js";
import { conjure } from "../../conjure/index.js";

// =============================================================================
// Permission Predicates
// =============================================================================

/** Entity with permissions field */
export type WithPermissions = { permissions: EntityPermissions };

/**
 * Predicate that returns true if the entity has any CRUD permission enabled.
 * Use with `.filter(hasAnyPermission)` to filter entities for HTTP route generation.
 */
export const hasAnyPermission = Predicate.some<WithPermissions>([
  e => e.permissions.canSelect,
  e => e.permissions.canInsert,
  e => e.permissions.canUpdate,
  e => e.permissions.canDelete,
]);

// =============================================================================
// Parameter Coercion
// =============================================================================

const b = conjure.b;

export function coerceParam(paramName: string, paramType: string): n.Expression {
  const ident = b.identifier(paramName);
  const lowerType = paramType.toLowerCase();

  if (lowerType === "number" || lowerType === "int" || lowerType === "integer" || lowerType === "bigint") {
    return b.callExpression(b.identifier("Number"), [ident]);
  }

  if (lowerType === "date" || lowerType.includes("timestamp") || lowerType.includes("datetime")) {
    return b.newExpression(b.identifier("Date"), [ident]);
  }

  if (lowerType === "boolean" || lowerType === "bool") {
    return b.binaryExpression("===", ident, b.stringLiteral("true"));
  }

  return ident;
}

export function needsCoercion(param: QueryMethodParam): boolean {
  return (
    param.source === "pk" ||
    param.source === "fk" ||
    param.source === "lookup" ||
    param.source === "pagination"
  );
}

export function toExternalImport(spec: SchemaImportSpec): ExternalImport {
  return {
    from: spec.from,
    names: spec.names,
    namespace: spec.namespace,
  };
}

export function buildQueryInvocation(handle: SymbolHandle, args: n.Expression[]): n.Expression {
  if (handle.consume && args.length <= 1) {
    const input = args.length === 0 ? undefined : args[0];
    return handle.consume(input as any) as n.Expression;
  }
  return handle.call(...args) as n.Expression;
}

export type HttpMethodMap = Record<QueryMethodKind, string>;

export const defaultHttpMethodMap: HttpMethodMap = {
  read: "get",
  list: "get",
  lookup: "get",
  create: "post",
  update: "put",
  delete: "delete",
  function: "post",
};

export function kindToHttpMethod(kind: QueryMethodKind, methodMap: HttpMethodMap = defaultHttpMethodMap): string {
  return methodMap[kind];
}

export interface RoutePathOptions {
  readonly kebabCase: (value: string) => string;
  readonly listByRoute?: (method: QueryMethod) => string | undefined;
  readonly lookupField?: (field: string) => string;
  readonly functionName?: (name: string) => string;
}

export function getRoutePath(method: QueryMethod, options: RoutePathOptions): string {
  switch (method.kind) {
    case "read":
    case "update":
    case "delete": {
      const pkParam = method.params.find((p) => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "list": {
      const listBy = options.listByRoute?.(method);
      return listBy ?? "/";
    }
    case "create":
      return "/";
    case "lookup": {
      const field = method.lookupField ?? "field";
      const lookupParam = method.params.find((p) => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      const lookupField = options.lookupField ? options.lookupField(field) : options.kebabCase(field);
      return `/by-${lookupField}/:${paramName}`;
    }
    case "function": {
      const fnName = options.functionName ? options.functionName(method.name) : options.kebabCase(method.name);
      return `/${fnName}`;
    }
  }
}

export function listByRouteFromName(method: QueryMethod, kebabCase: (value: string) => string): string | undefined {
  if (!/ListBy/i.test(method.name) && !/listBy/i.test(method.name)) {
    return undefined;
  }
  const match = method.name.match(/(?:ListBy|listBy)(.+)/i);
  if (!match || !match[1]) return undefined;
  return `/by-${kebabCase(match[1])}`;
}

export function getBodySchemaName(method: { kind: QueryMethodKind }, entityName: string): string | null {
  if (method.kind === "create") {
    return `${entityName}Insert`;
  }
  if (method.kind === "update") {
    return `${entityName}Update`;
  }
  return null;
}

// =============================================================================
// Entity Filtering
// =============================================================================

/**
 * Get table entities eligible for HTTP route generation.
 * Filters out entities with `@omit` tag and those without any CRUD permissions.
 *
 * @example
 * ```typescript
 * const entities = getHttpEligibleEntities(ir);
 * // Returns TableEntity[] with canSelect/canInsert/canUpdate/canDelete
 * ```
 */
export function getHttpEligibleEntities(ir: SemanticIR): TableEntity[] {
  return [...ir.entities.values()]
    .filter(isTableEntity)
    .filter(e => e.tags.omit !== true)
    .filter(hasAnyPermission);
}

// =============================================================================
// Registry Helpers
// =============================================================================

/**
 * Build a map of entity names to their query extensions from the registry.
 * Looks for capabilities matching `queries:{entityName}` pattern.
 *
 * @example
 * ```typescript
 * const entityQueries = buildEntityQueriesMap(registry);
 * // Map<"User", { methods: [...] }>
 * ```
 */
export function buildEntityQueriesMap(
  registry: SymbolRegistryService,
): Map<string, EntityQueriesExtension> {
  return registry.query("queries:").reduce((acc, decl) => {
    const parts = decl.capability.split(":");
    if (parts.length !== 3) return acc;

    const entityName = parts[2]!;
    const metadata = registry.getMetadata(decl.capability);
    if (metadata && typeof metadata === "object" && "methods" in metadata) {
      acc.set(entityName, metadata as EntityQueriesExtension);
    }
    return acc;
  }, new Map<string, EntityQueriesExtension>());
}

// =============================================================================
// Method Capability Mapping
// =============================================================================

/**
 * Get the capability suffix for a query method.
 *
 * Maps method kinds to capability names:
 * - read → "findById"
 * - list → "list" or "listBy{Field}"
 * - create → "create"
 * - update → "update"
 * - delete → "delete"
 * - lookup → "findBy{Field}"
 * - function → method.name
 *
 * @example
 * ```typescript
 * const suffix = getMethodCapabilitySuffix(method, "User", inflection);
 * // "findById", "list", "listByEmail", "create", etc.
 * const capability = `queries:${entityName}:${suffix}`;
 * ```
 */
export function getMethodCapabilitySuffix(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
): string {
  return Match.value(method.kind).pipe(
    Match.when("read", () => "findById"),
    Match.when("list", () => {
      const prefix = inflection.variableName(entityName, "");
      if (method.name.startsWith(prefix)) {
        const remainder = method.name.slice(prefix.length);
        if (remainder.startsWith("ListBy")) {
          const suffix = remainder.slice("ListBy".length);
          if (suffix.length > 0) {
            return `listBy${suffix}`;
          }
        }
      }
      return "list";
    }),
    Match.when("create", () => "create"),
    Match.when("update", () => "update"),
    Match.when("delete", () => "delete"),
    Match.when("lookup", () =>
      method.lookupField ? `findBy${inflection.pascalCase(method.lookupField)}` : "lookup",
    ),
    Match.when("function", () => method.name),
    Match.exhaustive,
  );
}
