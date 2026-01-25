import type { Field } from "../../ir/semantic-ir.js";

export const pgStringTypes = new Set([
  "uuid",
  "text",
  "varchar",
  "char",
  "character",
  "name",
  "bpchar",
  "citext",
  "tsvector",
  "tsquery",
]);

export const pgNumberTypes = new Set([
  "int2",
  "int4",
  "int8",
  "integer",
  "smallint",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "float4",
  "float8",
  "double",
]);

export const pgBooleanTypes = new Set(["bool", "boolean"]);

export const pgDateTypes = new Set(["timestamp", "timestamptz", "date", "time", "timetz"]);

export const pgJsonTypes = new Set(["json", "jsonb"]);

export function getPgType(field: Field): string {
  const pgType = field.pgAttribute.getType();
  return pgType?.typname ?? "unknown";
}

export function pgTypeToTsType(pgType: string): string {
  const lower = pgType.toLowerCase();
  if (pgStringTypes.has(lower)) return "string";
  if (pgNumberTypes.has(lower)) return "number";
  if (pgBooleanTypes.has(lower)) return "boolean";
  if (pgDateTypes.has(lower)) return "Date";
  if (pgJsonTypes.has(lower)) return "unknown";
  return "string";
}

export interface FieldTypeInfo {
  readonly typeName: string;
  readonly typeInfo: { typcategory?: string | null; typtype?: string | null };
}

export function resolveFieldTypeInfo(field: Field): FieldTypeInfo | undefined {
  const pgType = field.pgAttribute.getType();
  if (!pgType) return undefined;

  if (pgType.typcategory === "A") {
    return { typeName: field.elementTypeName ?? "unknown", typeInfo: pgType };
  }

  if (pgType.typtype === "d" && field.domainBaseType) {
    return {
      typeName: field.domainBaseType.typeName,
      typeInfo: { typcategory: field.domainBaseType.category },
    };
  }

  return { typeName: pgType.typname, typeInfo: pgType };
}
