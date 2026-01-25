import type { namedTypes as n } from "ast-types";

import type { SchemaImportSpec } from "../../ir/extensions/schema-builder.js";
import { QueryMethodKind, type QueryMethod, type QueryMethodParam } from "../../ir/extensions/queries.js";
import type { ExternalImport } from "../../runtime/emit.js";
import type { SymbolHandle } from "../../runtime/types.js";
import { conjure } from "../../conjure/index.js";

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
    return handle.consume(input as unknown) as n.Expression;
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
