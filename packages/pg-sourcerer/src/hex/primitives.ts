/**
 * Hex - Template-Based Primitives
 *
 * Lower-level template-based query building utilities.
 */
import type {
  QueryDescriptor,
  ParamDescriptor,
  ReturnDescriptor,
  FieldDescriptor,
  ReturnMode,
  QueryOperation,
  QueryMetadata,
} from "../shared/query-types.js";
import type { ParamSpec } from "./types.js";

export interface QueryParts {
  readonly templateParts: readonly string[];
}

export function toQueryDescriptor(
  name: string,
  entityName: string,
  operation: QueryOperation,
  parts: QueryParts,
  returns: ReturnDescriptor,
  params: readonly ParamDescriptor[],
  options?: {
    variant?: string;
    meta?: QueryMetadata;
  },
): QueryDescriptor {
  const sql = buildParameterizedSql(parts.templateParts);

  return {
    name,
    entityName,
    operation,
    variant: options?.variant,
    sql,
    params,
    returns,
    meta: options?.meta,
  };
}

export function buildReturnDescriptor(
  mode: ReturnMode,
  fields: readonly FieldDescriptor[],
): ReturnDescriptor {
  return { mode, fields };
}

export function buildParamDescriptor(
  name: string,
  tsType: string,
  pgType: string,
  options?: {
    nullable?: boolean;
    hasDefault?: boolean;
  },
): ParamDescriptor {
  return {
    name,
    tsType,
    pgType,
    nullable: options?.nullable ?? false,
    hasDefault: options?.hasDefault,
  };
}

export function buildFieldDescriptor(
  name: string,
  tsType: string,
  pgType: string,
  options?: {
    nullable?: boolean;
    isArray?: boolean;
  },
): FieldDescriptor {
  return {
    name,
    tsType,
    pgType,
    nullable: options?.nullable ?? false,
    isArray: options?.isArray,
  };
}

function buildParameterizedSql(parts: readonly string[]): string {
  return parts.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join("");
}
