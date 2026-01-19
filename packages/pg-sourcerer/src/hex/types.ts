/**
 * Hex - SQL Query Builder Types
 *
 * Type definitions for the declarative query builder API.
 */
import type { SemanticIR, TableEntity } from "../ir/semantic-ir.js";
import type {
  QueryDescriptor,
  ParamDescriptor,
  ReturnDescriptor,
  FieldDescriptor,
  ReturnMode,
  QueryOperation,
  QueryMetadata,
} from "../shared/query-types.js";

export type JoinType = "inner" | "left" | "right" | "full" | "cross" | "cross lateral";

export interface SelectItem {
  kind: "column" | "expression" | "star" | "lateral";
  from?: string;
  column?: string;
  expr?: string;
  func?: FunctionCall;
  alias?: string;
}

export interface FunctionCall {
  name: string;
  args: FunctionArg[];
  filter?: WhereCondition;
  orderBy?: OrderByItem[];
  window?: {
    partitionBy: (string | Expression)[];
    orderBy: OrderByItem[];
  };
}

export interface FunctionArg {
  kind: "column" | "star" | "expression" | "all";
  from?: string;
  column?: string;
  expr?: string;
  distinct?: boolean;
}

export interface FromItem {
  kind: "table" | "subquery";
  table?: string;
  subquery?: SelectSpec;
  alias?: string;
}

export interface JoinItem {
  type: JoinType;
  table: string;
  alias?: string;
  on?: string;
}

export interface WhereCondition {
  kind: "equals" | "notEquals" | "greater" | "greaterOrEqual" | "less" | "lessOrEqual" |
         "isNull" | "isNotNull" | "in" | "notIn" | "like" | "ilike" | "between" | "raw";
  column?: string;
  value?: ParamSpec | string | number | boolean | null;
  values?: (ParamSpec | string | number | boolean)[];
  low?: ParamSpec | string | number;
  high?: ParamSpec | string | number;
  expr?: string;
  subquery?: SelectSpec;
}

export interface OrderByItem {
  kind: "column" | "expression" | "param";
  from?: string;
  column?: string;
  expr?: string;
  param?: string;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
}

export interface GroupByItem {
  kind: "column" | "expression";
  from?: string;
  column?: string;
  expr?: string;
}

export interface HavingCondition {
  kind: "equals" | "notEquals" | "greater" | "greaterOrEqual" | "less" | "lessOrEqual";
  expr: string;
  value: ParamSpec | string | number;
}

export interface ParamSpec {
  name: string;
  pgType: string;
  tsType?: string;
  nullable?: boolean;
}

export interface CommonTableExpression {
  name: string;
  query: SelectSpec;
}

export interface SelectSpec {
  selects: SelectItem[];
  from: FromItem;
  joins?: JoinItem[];
  where?: WhereCondition[];
  orderBy?: OrderByItem[];
  groupBy?: GroupByItem[];
  having?: HavingCondition[];
  limit?: number | ParamSpec;
  offset?: number | ParamSpec;
  with?: CommonTableExpression[];
}

export interface MutationSpec {
  kind: "insert" | "update" | "delete" | "upsert";
  table: string;
  alias?: string;
  columns?: { column: string; value: ParamSpec | Expression | null }[];
  returning?: SelectItem[];
  where?: WhereCondition[];
}

export interface Expression {
  kind: "column" | "param" | "value" | "raw" | "subquery";
  from?: string;
  column?: string;
  param?: string;
  value?: string | number | boolean | null;
  expr?: string;
  subquery?: SelectSpec;
}

// =============================================================================
// DDL Types - Column Definition
// =============================================================================

export interface ColumnSpec {
  name: string;
  pgType: string;
  nullable?: boolean;
  hasDefault?: boolean;
  defaultValue?: string;
  isArray?: boolean;
  isIdentity?: boolean;
  generationKind?: "always" | "by default";
}

// =============================================================================
// DDL Types - Index Definition
// =============================================================================

export type IndexMethod = "btree" | "gin" | "gist" | "hash" | "brin" | "spgist";

export interface IndexSpec {
  name: string;
  columns: string[];
  method?: IndexMethod;
  unique?: boolean;
  isPrimaryKey?: boolean;
  where?: string;
  include?: string[];
  opclass?: Record<string, string>;
}

// =============================================================================
// DDL Types - Constraint Definition
// =============================================================================

export interface PrimaryKeySpec {
  columns: string[];
  name?: string;
}

export interface UniqueConstraintSpec {
  columns: string[];
  name?: string;
  where?: string;
}

export interface ExcludeConstraintSpec {
  columns: { name: string; opclass?: string }[];
  name?: string;
  using?: IndexMethod;
  where?: string;
}

export type TableConstraintSpec =
  | { kind: "primaryKey"; columns: string[]; name?: string }
  | { kind: "unique"; columns: string[]; name?: string; where?: string }
  | { kind: "exclude"; elements: { column: string; opclass?: string }[]; name?: string };

// =============================================================================
// DDL Types - Foreign Key Definition
// =============================================================================

export interface ForeignKeySpec {
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete?: "cascade" | "restrict" | "set null" | "set default";
  onUpdate?: "cascade" | "restrict" | "set null" | "set default";
  name?: string;
}

// =============================================================================
// DDL Types - Create Table Specification
// =============================================================================

export interface CreateTableSpec {
  table: string;
  schema?: string;
  columns: ColumnSpec[];
  primaryKey?: PrimaryKeySpec;
  constraints?: TableConstraintSpec[];
  indexes?: IndexSpec[];
  foreignKeys?: ForeignKeySpec[];
  ifNotExists?: boolean;
  inherits?: string[];
  like?: { table: string; including?: string[]; excluding?: string[] };
}

// =============================================================================
// DDL Types - Alter Table Specification
// =============================================================================

export interface AlterTableSpec {
  table: string;
  schema?: string;
  actions: AlterAction[];
}

export type AlterAction =
  | { kind: "addColumn"; column: ColumnSpec }
  | { kind: "dropColumn"; column: string; cascade?: boolean }
  | { kind: "alterColumnSetDefault"; column: string; setDefault: string | null }
  | { kind: "alterColumnSetNotNull"; column: string }
  | { kind: "alterColumnDropNotNull"; column: string }
  | { kind: "addConstraint"; constraint: TableConstraintSpec }
  | { kind: "dropConstraint"; name: string; cascade?: boolean }
  | { kind: "addForeignKey"; foreignKey: ForeignKeySpec }
  | { kind: "dropForeignKey"; name: string; cascade?: boolean }
  | { kind: "renameTo"; newName: string }
  | { kind: "renameColumn"; from: string; to: string };

// =============================================================================
// DDL Types - Drop Object Specification
// =============================================================================

export interface DropSpec {
  kind: "table" | "column" | "constraint" | "index" | "foreignKey" | "schema" | "type" | "function" | "trigger" | "rule";
  name: string;
  schema?: string;
  table?: string;
  ifExists?: boolean;
  cascade?: boolean;
}

// =============================================================================
// DDL Types - Utility
// =============================================================================

export interface SchemaInfo {
  schema: string;
  tables: string[];
  enums: string[];
  types: string[];
  functions: string[];
}

export interface BuilderState {
  params: ParamDescriptor[];
  paramCounter: number;
  tables: Map<string, TableEntity>;
  enums: Map<string, { name: string; values: readonly string[] }>;
  usedParamNames: Set<string>;
  lateralAliases: Set<string>;
  subqueryAliases: Set<string>;
}

export function createBuilderState(ir: SemanticIR): BuilderState {
  const tables = new Map<string, TableEntity>();
  const enums = new Map<string, { name: string; values: readonly string[] }>();

  for (const [name, entity] of ir.entities) {
    if (entity.kind === "table" || entity.kind === "view") {
      // Index by both entity name (User) and pgName (user) for flexible lookup
      tables.set(name, entity);
      tables.set(entity.pgName, entity);
    } else if (entity.kind === "enum") {
      enums.set(entity.pgName, { name: entity.name, values: entity.values });
    }
  }

  return {
    params: [],
    paramCounter: 0,
    tables,
    enums,
    usedParamNames: new Set(),
    lateralAliases: new Set(),
    subqueryAliases: new Set(),
  };
}

export function resolvePgType(state: BuilderState, column: string, allowLateral = false): string {
  if (column.endsWith(".*")) {
    return "unknown";
  }

  const [tableName, colName] = column.includes(".")
    ? column.split(".")
    : [undefined, column];

  if (tableName && state.subqueryAliases.has(tableName)) {
    return "unknown";
  }

  if (tableName && state.lateralAliases.has(tableName)) {
    if (allowLateral) {
      return "unknown";
    }
    throw new Error(`Cannot resolve type for LATERAL alias column: ${column}`);
  }

  const table = tableName ? state.tables.get(tableName) : undefined;
  if (!table) {
    throw new Error(`Unknown table: ${tableName || "implicit from context"}`);
  }

  const field = table.shapes.row.fields.find(f => f.columnName === colName);
  if (!field) {
    throw new Error(`Unknown column: ${column}`);
  }

  const pgType = field.pgAttribute.getType();
  if (!pgType) {
    throw new Error(`Could not resolve type for column: ${column}`);
  }

  return pgType.typname;
}

export function resolveTsType(state: BuilderState, pgType: string): string {
  const enumType = state.enums.get(pgType);
  if (enumType) {
    return enumType.name;
  }

  if (pgType.endsWith("[]")) {
    const baseType = resolveTsType(state, pgType.slice(0, -2));
    return `${baseType}[]`;
  }

  const mapping: Record<string, string> = {
    "bool": "boolean",
    "int2": "number",
    "int4": "number",
    "int8": "string",
    "float4": "number",
    "float8": "number",
    "numeric": "string",
    "text": "string",
    "varchar": "string",
    "bpchar": "string",
    "uuid": "string",
    "date": "Date",
    "timestamp": "Date",
    "timestamptz": "Date",
    "json": "unknown",
    "jsonb": "unknown",
    "bytea": "Buffer",
  };

  return mapping[pgType] || "unknown";
}

export function addParam(state: BuilderState, spec: ParamSpec): number {
  if (state.usedParamNames.has(spec.name)) {
    throw new Error(`Duplicate parameter name: ${spec.name}`);
  }
  state.usedParamNames.add(spec.name);

  const tsType = spec.tsType ?? resolveTsType(state, spec.pgType);

  state.params.push({
    name: spec.name,
    pgType: spec.pgType,
    tsType,
    nullable: spec.nullable ?? false,
  });

  return ++state.paramCounter;
}

export function nextPlaceholder(state: BuilderState): string {
  return `$${state.paramCounter + 1}`;
}

export function buildSelectItem(state: BuilderState, item: SelectItem): string {
  switch (item.kind) {
    case "column":
      if (!item.from || !item.column) {
        throw new Error("Column select item requires 'from' and 'column'");
      }
      return `${item.from}.${item.column}${item.alias ? ` AS "${item.alias}"` : ""}`;

    case "expression":
      if (!item.expr) {
        throw new Error("Expression select item requires 'expr'");
      }
      return `${item.expr}${item.alias ? ` AS "${item.alias}"` : ""}`;

    case "star":
      return item.from ? `${item.from}.*` : "*";

    case "lateral":
      if (!item.func || !item.alias) {
        throw new Error("Lateral select item requires 'func' and 'alias'");
      }
      return item.alias;

    default:
      throw new Error(`Unknown select item kind: ${(item as SelectItem).kind}`);
  }
}

export function buildFunctionCall(state: BuilderState, call: FunctionCall): string {
  const args = call.args.map(arg => {
    switch (arg.kind) {
      case "column":
        if (!arg.from || !arg.column) {
          throw new Error("Column function arg requires 'from' and 'column'");
        }
        return `${arg.from}.${arg.column}`;
      case "star":
        return "*";
      case "expression":
        if (!arg.expr) throw new Error("Expression function arg requires 'expr'");
        return arg.expr;
      case "all":
        if (!arg.from) throw new Error("All function arg requires 'from'");
        return `${arg.from}.*`;
      default:
        throw new Error(`Unknown function arg kind: ${(arg as FunctionArg).kind}`);
    }
  }).join(", ");

  const funcExpr = `${call.name}(${args})`;

  if (call.window) {
    const partitionBy = call.window.partitionBy.map(p =>
      typeof p === "string" ? p : p.expr
    ).join(", ");
    const orderBy = call.window.orderBy.map(o =>
      `${o.column} ${o.direction.toUpperCase()}`
    ).join(", ");
    return `${funcExpr} OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy})`;
  }

  return funcExpr;
}

export function buildFromClause(state: BuilderState, from: FromItem): string {
  if (from.kind === "table") {
    if (!from.table) {
      throw new Error("From item requires 'table'");
    }
    return `FROM ${from.table}${from.alias ? ` AS ${from.alias}` : ""}`;
  }

  if (from.kind === "subquery") {
    if (!from.subquery) {
      throw new Error("Subquery from item requires 'subquery'");
    }
    const subquerySql = buildSelectQuery(state, from.subquery);
    if (from.alias) {
      state.subqueryAliases.add(from.alias);
    }
    return `FROM (${subquerySql})${from.alias ? ` AS ${from.alias}` : ""}`;
  }

  throw new Error(`Unknown from kind: ${(from as FromItem).kind}`);
}

export function buildJoinClause(join: JoinItem): string {
  const alias = join.alias ? ` AS ${join.alias}` : "";

  if (join.type === "cross lateral") {
    return `CROSS JOIN LATERAL ${join.table}${alias}`;
  }

  const on = join.on ? ` ON ${join.on}` : "";
  return `${join.type.toUpperCase()} JOIN ${join.table}${alias}${on}`;
}

export function buildWhereClause(state: BuilderState, conditions: WhereCondition[]): string {
  if (conditions.length === 0) return "";

  const clauses = conditions.map(cond => {
    switch (cond.kind) {
      case "equals":
        if (!cond.column) throw new Error("Equals condition requires 'column'");
        if (!cond.value) throw new Error("Equals condition requires 'value'");
        if (isParamSpec(cond.value)) {
          const placeholder = nextPlaceholder(state);
          addParam(state, cond.value);
          return `${cond.column} = ${placeholder}`;
        }
        return `${cond.column} = ${formatValue(cond.value)}`;

      case "notEquals":
        if (!cond.column) throw new Error("NotEquals condition requires 'column'");
        if (!cond.value) throw new Error("NotEquals condition requires 'value'");
        if (isParamSpec(cond.value)) {
          const placeholder = nextPlaceholder(state);
          addParam(state, cond.value);
          return `${cond.column} <> ${placeholder}`;
        }
        return `${cond.column} <> ${formatValue(cond.value)}`;

      case "isNull":
        if (!cond.column) throw new Error("IsNull condition requires 'column'");
        return `${cond.column} IS NULL`;

      case "isNotNull":
        if (!cond.column) throw new Error("IsNotNull condition requires 'column'");
        return `${cond.column} IS NOT NULL`;

      case "raw":
        if (!cond.expr) throw new Error("Raw condition requires 'expr'");
        return cond.expr;

      default:
        throw new Error(`Unknown where condition kind: ${(cond as WhereCondition).kind}`);
    }
  });

  return `WHERE ${clauses.join(" AND ")}`;
}

export function buildOrderByClause(orderBy: OrderByItem[]): string {
  const clauses = orderBy.map(item => {
    let expr: string;
    if (item.kind === "column") {
      expr = `${item.from ? `${item.from}.` : ""}${item.column}`;
    } else if (item.kind === "expression") {
      expr = item.expr!;
    } else {
      throw new Error(`Unsupported order by kind: ${item.kind}`);
    }
    const direction = item.direction.toUpperCase();
    const nulls = item.nulls ? ` NULLS ${item.nulls === "first" ? "FIRST" : "LAST"}` : "";
    return `${expr} ${direction}${nulls}`;
  });

  return `ORDER BY ${clauses.join(", ")}`;
}

export function buildGroupByClause(groupBy: GroupByItem[]): string {
  const clauses = groupBy.map(item => {
    if (item.kind === "column") {
      return `${item.from ? `${item.from}.` : ""}${item.column}`;
    }
    return item.expr!;
  });
  return `GROUP BY ${clauses.join(", ")}`;
}

function isParamSpec(value: unknown): value is ParamSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "pgType" in value
  );
}

function formatValue(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

export function buildValueOrParam(state: BuilderState, value: ParamSpec | Expression | null): string {
  if (value === null) return "NULL";
  if (isParamSpec(value)) {
    const placeholder = nextPlaceholder(state);
    addParam(state, value);
    return placeholder;
  }
  return buildExpression(state, value);
}

export function buildExpression(state: BuilderState, expr: Expression): string {
  switch (expr.kind) {
    case "column":
      if (!expr.from || !expr.column) {
        throw new Error("Column expression requires 'from' and 'column'");
      }
      return `${expr.from}.${expr.column}`;

    case "param":
      if (!expr.param) throw new Error("Param expression requires 'param'");
      const placeholder = nextPlaceholder(state);
      addParam(state, { name: expr.param, pgType: "unknown" });
      return placeholder;

    case "value":
      return formatValue(expr.value ?? null);

    case "raw":
      if (!expr.expr) throw new Error("Raw expression requires 'expr'");
      return expr.expr;

    case "subquery":
      if (!expr.subquery) throw new Error("Subquery expression requires 'subquery'");
      return `(${buildSelectQuery(state, expr.subquery)})`;

    default:
      throw new Error(`Unknown expression kind: ${(expr as Expression).kind}`);
  }
}

export function buildMutationQuery(state: BuilderState, spec: MutationSpec): string {
  const alias = spec.alias ? ` AS ${spec.alias}` : "";

  switch (spec.kind) {
    case "insert": {
      if (!spec.columns) {
        throw new Error("INSERT requires 'columns'");
      }
      const columns = spec.columns.map(c => c.column).join(", ");
      const values = spec.columns.map(c => buildValueOrParam(state, c.value)).join(", ");
      const returning = spec.returning ? ` RETURNING ${spec.returning.map(r => buildSelectItem(state, r)).join(", ")}` : "";
      return `INSERT INTO ${spec.table}${alias} (${columns}) VALUES (${values})${returning}`;
    }

    case "update": {
      if (!spec.columns) {
        throw new Error("UPDATE requires 'columns'");
      }
      const setClauses = spec.columns.map(c => `${c.column} = ${buildValueOrParam(state, c.value)}`).join(", ");
      const where = spec.where ? ` ${buildWhereClause(state, spec.where)}` : "";
      const returning = spec.returning ? ` RETURNING ${spec.returning.map(r => buildSelectItem(state, r)).join(", ")}` : "";
      return `UPDATE ${spec.table}${alias} SET ${setClauses}${where}${returning}`;
    }

    case "delete": {
      const where = spec.where ? ` ${buildWhereClause(state, spec.where)}` : "";
      const returning = spec.returning ? ` RETURNING ${spec.returning.map(r => buildSelectItem(state, r)).join(", ")}` : "";
      return `DELETE FROM ${spec.table}${alias}${where}${returning}`;
    }

    case "upsert": {
      if (!spec.columns) {
        throw new Error("UPSERT requires 'columns'");
      }
      const columns = spec.columns.map(c => c.column).join(", ");
      const values = spec.columns.map(c => buildValueOrParam(state, c.value)).join(", ");
      const conflictColumns = spec.columns.map(c => c.column).join(", ");
      const updateClauses = spec.columns.map(c => `${c.column} = EXCLUDED.${c.column}`).join(", ");
      const returning = spec.returning ? ` RETURNING ${spec.returning.map(r => buildSelectItem(state, r)).join(", ")}` : "";
      return `INSERT INTO ${spec.table}${alias} (${columns}) VALUES (${values}) ON CONFLICT (${conflictColumns}) DO UPDATE SET ${updateClauses}${returning}`;
    }

    default:
      throw new Error(`Unknown mutation kind: ${(spec as MutationSpec).kind}`);
  }
}

export function buildSelectQuery(state: BuilderState, spec: SelectSpec): string {
  const clauses: string[] = [];

  if (spec.with && spec.with.length > 0) {
    const cteClauses = spec.with.map(cte => {
      const querySql = buildSelectQuery(state, cte.query);
      return `${cte.name} AS (${querySql})`;
    });
    clauses.push(`WITH ${cteClauses.join(", ")}`);
  }

  const selectItems = spec.selects.map(item => buildSelectItem(state, item));
  clauses.push(`SELECT ${selectItems.join(", ")}`);

  clauses.push(buildFromClause(state, spec.from));

  if (spec.joins) {
    spec.joins.filter(j => j.type === "cross lateral" && j.alias).forEach(j => state.lateralAliases.add(j.alias!));
    clauses.push(...spec.joins.map(buildJoinClause));
  }

  if (spec.where) {
    clauses.push(buildWhereClause(state, spec.where));
  }

  if (spec.groupBy) {
    clauses.push(buildGroupByClause(spec.groupBy));
  }

  if (spec.orderBy) {
    clauses.push(buildOrderByClause(spec.orderBy));
  }

  if (spec.limit !== undefined) {
    if (typeof spec.limit === "number") {
      clauses.push(`LIMIT ${spec.limit}`);
    } else {
      clauses.push(`LIMIT ${nextPlaceholder(state)}`);
      addParam(state, spec.limit);
    }
  }

  if (spec.offset !== undefined) {
    if (typeof spec.offset === "number") {
      clauses.push(`OFFSET ${spec.offset}`);
    } else {
      clauses.push(`OFFSET ${nextPlaceholder(state)}`);
      addParam(state, spec.offset);
    }
  }

  return clauses.join(" ");
}

export function inferReturnFields(state: BuilderState, selects: SelectItem[]): FieldDescriptor[] {
  return selects.map(item => {
    if (item.kind === "column" && item.from && item.column) {
      const pgType = resolvePgType(state, `${item.from}.${item.column}`, true);
      const tsType = resolveTsType(state, pgType);
      return {
        name: item.alias ?? item.column,
        tsType,
        pgType,
        nullable: false,
      };
    }

    if (item.kind === "star") {
      return { name: "*", tsType: "unknown", pgType: "unknown", nullable: false };
    }

    if (item.kind === "lateral" && item.alias) {
      return { name: item.alias, tsType: "unknown", pgType: "unknown", nullable: false };
    }

    if (item.kind === "expression" && item.expr) {
      const pgType = inferExpressionPgType(item.expr);
      const tsType = resolveTsType(state, pgType);
      return { name: item.alias ?? "expr", tsType, pgType, nullable: false };
    }

    return { name: item.alias ?? "unknown", tsType: "unknown", pgType: "unknown", nullable: false };
  });
}

export function inferExpressionPgType(expr: string): string {
  const lower = expr.toLowerCase();

  if (lower.startsWith("count")) return "bigint";
  if (lower.startsWith("sum") || lower.startsWith("avg")) return "numeric";
  if (lower.startsWith("min") || lower.startsWith("max")) return "text";
  if (lower.includes("json_agg") || lower.includes("json_build_object")) return "jsonb";
  if (lower.includes("array_agg")) return "text[]";

  return "text";
}
