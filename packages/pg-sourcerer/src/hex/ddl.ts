/**
 * Hex - DDL Query Builder
 *
 * Declarative query builder for DDL statements (CREATE TABLE, ALTER TABLE, etc.).
 * Integrates with SemanticIR for type-aware schema generation.
 */
import type { SemanticIR } from "../ir/semantic-ir.js";
import type {
  CreateTableSpec,
  AlterTableSpec,
  IndexSpec,
  ForeignKeySpec,
  DropSpec,
  ColumnSpec,
  TableConstraintSpec,
} from "./types.js";

export { IndexMethod } from "./types.js";

function quoteIdent(name: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && !name.match(/^(true|false|null)$/i)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function buildSchemaObjectName(name: string, schema?: string): string {
  const parts = name.split(".");
  if (parts.length > 1) {
    return `${quoteIdent(parts[0]!)}.${quoteIdent(parts[1]!)}`;
  }
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

function buildColumnDefinition(column: ColumnSpec): string {
  const parts: string[] = [quoteIdent(column.name), column.pgType];

  if (column.isIdentity) {
    parts.push("GENERATED");
    if (column.generationKind === "always") {
      parts.push("ALWAYS");
    } else {
      parts.push("BY DEFAULT");
    }
    parts.push("AS IDENTITY");
  }

  if (!column.nullable) {
    parts.push("NOT NULL");
  }

  if (column.hasDefault && column.defaultValue !== undefined) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }

  if (column.isArray) {
    parts[parts.length - 1] += "[]";
  }

  return parts.join(" ");
}

function buildIndexColumns(index: IndexSpec): string {
  if (index.include && index.include.length > 0) {
    const indexCols = index.columns.map(c => quoteIdent(c)).join(", ");
    const includeCols = index.include.map(c => quoteIdent(c)).join(", ");
    return `(${indexCols}) INCLUDE (${includeCols})`;
  }
  return index.columns.map(c => quoteIdent(c)).join(", ");
}

function buildIndexSpec(index: IndexSpec): string {
  const name = index.name ? `CONCURRENTLY ${quoteIdent(index.name)}` : "";
  const unique = index.unique ? "UNIQUE " : "";
  const method = index.method ? ` USING ${index.method.toUpperCase()}` : "";
  const columns = buildIndexColumns(index);
  const where = index.where ? ` WHERE ${index.where}` : "";

  return `${unique}${name}${method} (${columns})${where}`;
}

function buildForeignKey(foreignKey: ForeignKeySpec): string {
  const columns = foreignKey.columns.map(quoteIdent).join(", ");
  const targetParts = foreignKey.targetTable.split(".");
  const target = targetParts.length > 1
    ? `${quoteIdent(targetParts[0]!)}.${quoteIdent(targetParts[1]!)}`
    : quoteIdent(foreignKey.targetTable);
  const targetColumns = foreignKey.targetColumns.map(quoteIdent).join(", ");

  const actions: string[] = [];
  if (foreignKey.onDelete) {
    actions.push(`ON DELETE ${foreignKey.onDelete.toUpperCase().replace(/ /g, " ")}`);
  }
  if (foreignKey.onUpdate) {
    actions.push(`ON UPDATE ${foreignKey.onUpdate.toUpperCase().replace(/ /g, " ")}`);
  }

  const fkName = foreignKey.name ? `CONSTRAINT ${quoteIdent(foreignKey.name)} ` : "";
  return `${fkName}FOREIGN KEY (${columns}) REFERENCES ${target} (${targetColumns})${actions.length > 0 ? " " + actions.join(" ") : ""}`;
}

function buildConstraint(constraint: TableConstraintSpec): string {
  switch (constraint.kind) {
    case "primaryKey": {
      const name = constraint.name ? `CONSTRAINT ${quoteIdent(constraint.name)}` : "";
      const columns = constraint.columns.map(quoteIdent).join(", ");
      return `${name} PRIMARY KEY (${columns})`;
    }
    case "unique": {
      const name = constraint.name ? `CONSTRAINT ${quoteIdent(constraint.name)}` : "";
      const columns = constraint.columns.map(quoteIdent).join(", ");
      const where = constraint.where ? ` WHERE ${constraint.where}` : "";
      return `${name} UNIQUE (${columns})${where}`;
    }
    case "exclude": {
      const name = constraint.name ? `CONSTRAINT ${quoteIdent(constraint.name)}` : "";
      const using = constraint.elements.some(e => e.opclass) ? "USING gist" : "";
      const elements = constraint.elements
        .map(e => {
          if (e.opclass) {
            return `${quoteIdent(e.column)} WITH ${e.opclass}`;
          }
          return quoteIdent(e.column);
        })
        .join(", ");
      return `${name} EXCLUDE ${using} (${elements})`;
    }
    default:
      throw new Error(`Unknown constraint kind: ${(constraint as TableConstraintSpec).kind}`);
  }
}

export function createTable(_ir: SemanticIR, spec: CreateTableSpec): string {
  const ifNotExists = spec.ifNotExists ? "IF NOT EXISTS " : "";
  const tableName = spec.schema
    ? `${quoteIdent(spec.schema)}.${quoteIdent(spec.table)}`
    : quoteIdent(spec.table);

  const lines: string[] = [`CREATE TABLE ${ifNotExists}${tableName} (`];

  const columnDefs = spec.columns.map(buildColumnDefinition);
  const constraintDefs = (spec.constraints ?? []).map(buildConstraint);

  const allDefs = [...columnDefs];
  if (spec.primaryKey) {
    const pkName = spec.primaryKey.name ? `CONSTRAINT ${quoteIdent(spec.primaryKey.name)}` : "";
    const pkCols = spec.primaryKey.columns.map(quoteIdent).join(", ");
    allDefs.push(`${pkName} PRIMARY KEY (${pkCols})`);
  }
  allDefs.push(...constraintDefs);

  if (spec.indexes && spec.indexes.length > 0) {
    for (const idx of spec.indexes) {
      if (idx.isPrimaryKey) continue;
      allDefs.push(`  CONSTRAINT ${quoteIdent(idx.name)} CHECK (true)`);
    }
  }

  lines.push(allDefs.map(d => `  ${d}`).join(",\n"));

  if (spec.foreignKeys && spec.foreignKeys.length > 0) {
    for (const fk of spec.foreignKeys) {
      lines.push(`,  ${buildForeignKey(fk)}`);
    }
  }

  if (spec.inherits && spec.inherits.length > 0) {
    const inherits = spec.inherits.map(t => buildSchemaObjectName(t)).join(", ");
    lines.push(`) INHERITS (${inherits})`);
  } else if (spec.like) {
    const likeTable = buildSchemaObjectName(spec.like.table);
    const including = spec.like.including ? `INCLUDING ${spec.like.including.join(" ")}` : "";
    const excluding = spec.like.excluding ? `EXCLUDING ${spec.like.excluding.join(" ")}` : "";
    lines.push(`) LIKE ${likeTable} ${including} ${excluding}`);
  } else {
    lines.push(")");
  }

  return lines.join("\n");
}

export function createIndex(
  _ir: SemanticIR,
  tableName: string,
  index: IndexSpec,
  options: { concurrently?: boolean; ifNotExists?: boolean; schema?: string } = {},
): string {
  const concurrently = options.concurrently ? "CONCURRENTLY " : "";
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS " : "";
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);

  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${concurrently}${ifNotExists}${quoteIdent(index.name)} ON ${table}${index.method ? ` USING ${index.method.toUpperCase()}` : ""} (${buildIndexColumns(index)}${index.where ? ` WHERE ${index.where}` : ""})`;
}

export function createPrimaryKeyIndex(
  _ir: SemanticIR,
  tableName: string,
  columns: string[],
  indexName: string,
  options: { concurrently?: boolean; schema?: string } = {},
): string {
  const concurrently = options.concurrently ? "CONCURRENTLY " : "";
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);
  const indexCols = columns.map(quoteIdent).join(", ");

  return `CREATE UNIQUE INDEX ${concurrently}${quoteIdent(indexName)} ON ${table} USING btree (${indexCols})`;
}

export function addForeignKey(_ir: SemanticIR, tableName: string, foreignKey: ForeignKeySpec, options: { schema?: string } = {}): string {
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);

  return `ALTER TABLE ${table} ADD ${buildForeignKey(foreignKey)}`;
}

export function dropForeignKey(_ir: SemanticIR, tableName: string, constraintName: string, options: { schema?: string; ifExists?: boolean; cascade?: boolean } = {}): string {
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);
  const ifExists = options.ifExists ? "IF EXISTS " : "";
  const cascade = options.cascade ? " CASCADE" : "";

  return `ALTER TABLE ${table} DROP CONSTRAINT ${ifExists}${quoteIdent(constraintName)}${cascade}`;
}

export function dropIndex(indexName: string, options: { ifExists?: boolean; cascade?: boolean; concurrently?: boolean } = {}): string {
  const ifExists = options.ifExists ? "IF EXISTS " : "";
  const concurrently = options.concurrently ? "CONCURRENTLY " : "";
  const cascade = options.cascade ? " CASCADE" : "";

  return `DROP INDEX ${concurrently}${ifExists}${quoteIdent(indexName)}${cascade}`;
}

export function dropTable(tableName: string, options: { schema?: string; ifExists?: boolean; cascade?: boolean } = {}): string {
  const ifExists = options.ifExists ? "IF EXISTS " : "";
  const cascade = options.cascade ? " CASCADE" : "";
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);

  return `DROP TABLE ${ifExists}${table}${cascade}`;
}

export function alterTable(_ir: SemanticIR, spec: AlterTableSpec): string {
  const table = spec.schema
    ? `${quoteIdent(spec.schema)}.${quoteIdent(spec.table)}`
    : quoteIdent(spec.table);

  const actions = spec.actions.map(action => {
    switch (action.kind) {
      case "addColumn": {
        return `  ADD COLUMN ${buildColumnDefinition(action.column)}`;
      }
      case "dropColumn": {
        const cascade = action.cascade ? " CASCADE" : "";
        return `  DROP COLUMN ${quoteIdent(action.column)}${cascade}`;
      }
      case "alterColumnSetDefault": {
        const defaultValue = action.setDefault === null ? "DROP DEFAULT" : `SET DEFAULT ${action.setDefault}`;
        return `  ALTER COLUMN ${quoteIdent(action.column)} ${defaultValue}`;
      }
      case "alterColumnSetNotNull": {
        return `  ALTER COLUMN ${quoteIdent(action.column)} SET NOT NULL`;
      }
      case "alterColumnDropNotNull": {
        return `  ALTER COLUMN ${quoteIdent(action.column)} DROP NOT NULL`;
      }
      case "addConstraint": {
        return `  ADD ${buildConstraint(action.constraint)}`;
      }
      case "dropConstraint": {
        const cascade = action.cascade ? " CASCADE" : "";
        return `  DROP CONSTRAINT ${quoteIdent(action.name)}${cascade}`;
      }
      case "addForeignKey": {
        return `  ADD ${buildForeignKey(action.foreignKey)}`;
      }
      case "dropForeignKey": {
        const cascade = action.cascade ? " CASCADE" : "";
        return `  DROP CONSTRAINT ${quoteIdent(action.name)}${cascade}`;
      }
      case "renameTo": {
        return `  RENAME TO ${quoteIdent(action.newName)}`;
      }
      case "renameColumn": {
        return `  RENAME COLUMN ${quoteIdent(action.from)} TO ${quoteIdent(action.to)}`;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown alter action: ${(_exhaustive as { kind: string }).kind}`);
      }
    }
  }).filter(Boolean);

  if (actions.length === 0) {
    return `-- No changes for ${table}`;
  }

  return `ALTER TABLE ${table}\n${actions.join("\n")}`;
}

export function drop(spec: DropSpec): string {
  const ifExists = spec.ifExists ? "IF EXISTS " : "";
  const cascade = spec.cascade ? " CASCADE" : "";
  const schema = spec.schema ? `${quoteIdent(spec.schema)}.` : "";

  switch (spec.kind) {
    case "table":
      return `DROP TABLE ${ifExists}${schema}${quoteIdent(spec.name)}${cascade}`;
    case "column":
      return `ALTER TABLE ${schema}${quoteIdent(spec.name)} DROP COLUMN ${ifExists}${cascade}`;
    case "constraint":
      return `ALTER TABLE ${schema}${quoteIdent(spec.name)} DROP CONSTRAINT ${ifExists}${cascade}`;
    case "index":
      return `DROP INDEX ${ifExists}${schema}${quoteIdent(spec.name)}${cascade}`;
    case "foreignKey": {
      const parts = spec.name.split(".");
      const hasSchema = parts.length > 1;
      const table = hasSchema ? parts[0]! : spec.table ?? "";
      const constraint = hasSchema ? parts[1]! : parts[0]!;
      const tableSchema = spec.schema ? `${quoteIdent(spec.schema)}.` : "";
      const tableName = table ? `${tableSchema}${quoteIdent(table)}` : "";
      return `ALTER TABLE ${tableName} DROP CONSTRAINT ${ifExists}${quoteIdent(constraint)}${cascade}`;
    }
    case "schema":
      return `DROP SCHEMA ${ifExists}${schema}${cascade}`;
    case "type":
      return `DROP TYPE ${ifExists}${schema}${quoteIdent(spec.name)}${cascade}`;
    case "function": {
      const argList = spec.name.includes("(") ? spec.name.slice(spec.name.indexOf("(")) : "";
      const funcName = spec.name.includes("(") ? spec.name.slice(0, spec.name.indexOf("(")) : spec.name;
      return `DROP FUNCTION ${ifExists}${schema}${quoteIdent(funcName)}${argList}${cascade}`;
    }
    case "trigger":
      return `DROP TRIGGER ${ifExists}${quoteIdent(spec.name)} ON ${schema}${quoteIdent(spec.table ?? "")}${cascade}`;
    case "rule":
      return `DROP RULE ${ifExists}${quoteIdent(spec.name)} ON ${schema}${quoteIdent(spec.table ?? "")}${cascade}`;
    default:
      throw new Error(`Unknown drop kind: ${(spec as DropSpec).kind}`);
  }
}

export function renameTable(oldName: string, newName: string, options: { schema?: string } = {}): string {
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(oldName)}`
    : quoteIdent(oldName);
  const newTableName = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(newName)}`
    : quoteIdent(newName);

  return `ALTER TABLE ${table} RENAME TO ${newTableName}`;
}

export function renameColumn(tableName: string, oldColumn: string, newColumn: string, options: { schema?: string } = {}): string {
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);

  return `ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(oldColumn)} TO ${quoteIdent(newColumn)}`;
}

export function renameConstraint(tableName: string, oldConstraint: string, newConstraint: string, options: { schema?: string } = {}): string {
  const table = options.schema
    ? `${quoteIdent(options.schema)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName);

  return `ALTER TABLE ${table} RENAME CONSTRAINT ${quoteIdent(oldConstraint)} TO ${quoteIdent(newConstraint)}`;
}

export function setSchema(objectName: string, newSchema: string, options: { schema?: string; cascade?: boolean } = {}): string {
  const cascade = options.cascade ? " CASCADE" : "";
  const currentSchema = options.schema ? `${quoteIdent(options.schema)}.` : "";

  return `ALTER ${currentSchema}${quoteIdent(objectName)} SET SCHEMA ${quoteIdent(newSchema)}${cascade}`;
}
