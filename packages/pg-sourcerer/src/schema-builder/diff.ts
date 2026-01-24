/**
 * Schema Diff Logic
 *
 * Converts IR entities to builder state and computes diffs to generate ALTER statements.
 */
import type { TableEntity, Field, IndexDef, Relation } from "../ir/semantic-ir.js";
import type {
  SchemaBuilderState,
  ColumnSpec,
  PrimaryKeySpec,
  ForeignKeySpec,
  IndexSpec,
} from "./state.js";
import type { AlterAction, AlterTableSpec } from "../hex/types.js";
import { alterTable, createIndex, dropIndex } from "../hex/ddl.js";

// =============================================================================
// Convert IR Entity to Builder State
// =============================================================================

/**
 * Convert a Field from IR to ColumnSpec for the builder.
 */
function fieldToColumnSpec(field: Field): ColumnSpec {
  const pgType = field.pgAttribute.getType();
  const typeName = pgType?.typname ?? "text";

  // Check if it's an array type (starts with underscore in pg)
  const isArray = typeName.startsWith("_");
  const baseType = isArray ? typeName.slice(1) : typeName;

  // Check for identity column
  const attidentity = (field.pgAttribute as any).attidentity;
  const isIdentityCol = attidentity === "a" || attidentity === "d";
  const generationKind = attidentity === "a" ? "always" : "by default";

  // Get default value
  let defaultValue: string | undefined;
  if (field.hasDefault) {
    // Get default from pg_attrdef via the attribute
    const attrDef = (field.pgAttribute as any).getDefault?.();
    defaultValue = attrDef?.adsrc;
  }

  return {
    name: field.columnName,
    pgType: baseType,
    nullable: field.nullable,
    isArray,
    isIdentity: isIdentityCol || undefined,
    generationKind: isIdentityCol ? generationKind : undefined,
    hasDefault: field.hasDefault || undefined,
    defaultValue,
  };
}

/**
 * Convert an IndexDef from IR to IndexSpec for the builder.
 */
function indexDefToIndexSpec(index: IndexDef): IndexSpec {
  return {
    name: index.name,
    columns: [...index.columnNames], // Use original PG column names
    method: index.method,
    unique: index.isUnique,
    isPrimaryKey: index.isPrimary,
    where: index.predicate,
  };
}

/**
 * Convert a belongsTo Relation to ForeignKeySpec.
 */
function relationToForeignKeySpec(
  relation: Relation,
  targetEntity: TableEntity,
): ForeignKeySpec {
  const targetTable =
    targetEntity.schemaName === "public"
      ? targetEntity.pgName
      : `${targetEntity.schemaName}.${targetEntity.pgName}`;

  return {
    columns: relation.columns.map((c) => c.local),
    targetTable,
    targetColumns: relation.columns.map((c) => c.foreign),
    name: relation.constraintName,
    // Note: ON DELETE/UPDATE actions aren't stored in IR relations
    // Would need to query pg_constraint directly for those
  };
}

/**
 * Convert a TableEntity from IR to SchemaBuilderState.
 */
export function tableEntityToState(
  entity: TableEntity,
  entityMap: Map<string, TableEntity>,
): SchemaBuilderState {
  // Convert columns
  const columns = entity.shapes.row.fields.map(fieldToColumnSpec);

  // Convert primary key
  const primaryKey: PrimaryKeySpec | null = entity.primaryKey
    ? { columns: [...entity.primaryKey.columns] }
    : null;

  // Convert indexes (exclude primary key index)
  const indexes = entity.indexes
    .filter((idx) => !idx.isPrimary)
    .map(indexDefToIndexSpec);

  // Convert foreign keys (from belongsTo relations)
  const foreignKeys: ForeignKeySpec[] = [];
  for (const rel of entity.relations) {
    if (rel.kind === "belongsTo") {
      const targetEntity = entityMap.get(rel.targetEntity);
      if (targetEntity && targetEntity.kind === "table") {
        foreignKeys.push(relationToForeignKeySpec(rel, targetEntity));
      }
    }
  }

  return {
    tableName: entity.pgName,
    schema: entity.schemaName,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    constraints: [], // TODO: unique constraints, check constraints
  };
}

// =============================================================================
// Compute Diff
// =============================================================================

/**
 * Compute the diff between original and modified states.
 * Returns ALTER actions needed to transform original → modified.
 */
export function computeDiff(
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
): AlterAction[] {
  const actions: AlterAction[] = [];

  // Map columns by name for easy lookup
  const originalColumns = new Map(original.columns.map((c) => [c.name, c]));
  const modifiedColumns = new Map(modified.columns.map((c) => [c.name, c]));

  // Check for renamed columns (heuristic: same position, different name)
  // For now, we'll treat renames as drop + add (safer)

  // Dropped columns
  for (const [name, col] of originalColumns) {
    if (!modifiedColumns.has(name)) {
      actions.push({ kind: "dropColumn", column: name });
    }
  }

  // Added columns
  for (const [name, col] of modifiedColumns) {
    if (!originalColumns.has(name)) {
      actions.push({ kind: "addColumn", column: col });
    }
  }

  // Modified columns (same name, different properties)
  for (const [name, modCol] of modifiedColumns) {
    const origCol = originalColumns.get(name);
    if (!origCol) continue;

    // Check nullability change
    if (origCol.nullable && !modCol.nullable) {
      actions.push({ kind: "alterColumnSetNotNull", column: name });
    } else if (!origCol.nullable && modCol.nullable) {
      actions.push({ kind: "alterColumnDropNotNull", column: name });
    }

    // Check default change
    if (origCol.defaultValue !== modCol.defaultValue) {
      actions.push({
        kind: "alterColumnSetDefault",
        column: name,
        setDefault: modCol.hasDefault ? (modCol.defaultValue ?? null) : null,
      });
    }

    // Note: Type changes require DROP + ADD or ALTER TYPE (complex)
    // For now we don't handle type changes
  }

  // Foreign key changes
  const originalFks = new Map(original.foreignKeys.map((fk) => [fk.name ?? fk.columns.join(","), fk]));
  const modifiedFks = new Map(modified.foreignKeys.map((fk) => [fk.name ?? fk.columns.join(","), fk]));

  for (const [key, fk] of originalFks) {
    if (!modifiedFks.has(key)) {
      if (fk.name) {
        actions.push({ kind: "dropForeignKey", name: fk.name });
      }
    }
  }

  for (const [key, fk] of modifiedFks) {
    if (!originalFks.has(key)) {
      actions.push({ kind: "addForeignKey", foreignKey: fk });
    }
  }

  // Note: Index changes are handled separately (CREATE INDEX / DROP INDEX)
  // They're not part of ALTER TABLE

  return actions;
}

/**
 * Compute index changes (separate from ALTER TABLE).
 * Returns [indexesToDrop, indexesToCreate]
 */
export function computeIndexDiff(
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
): [IndexSpec[], IndexSpec[]] {
  const originalIndexes = new Map(original.indexes.map((idx) => [idx.name, idx]));
  const modifiedIndexes = new Map(modified.indexes.map((idx) => [idx.name, idx]));

  const toDrop: IndexSpec[] = [];
  const toCreate: IndexSpec[] = [];

  for (const [name, idx] of originalIndexes) {
    if (!modifiedIndexes.has(name)) {
      toDrop.push(idx);
    }
  }

  for (const [name, idx] of modifiedIndexes) {
    if (!originalIndexes.has(name)) {
      toCreate.push(idx);
    }
  }

  return [toDrop, toCreate];
}

// =============================================================================
// Generate Migration DDL
// =============================================================================

/**
 * Generate full migration DDL from original and modified states.
 */
export function generateMigrationDDL(
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
): string {
  const lines: string[] = [];

  // Compute ALTER TABLE actions
  const actions = computeDiff(original, modified);

  if (actions.length > 0) {
    const spec: AlterTableSpec = {
      table: original.tableName,
      schema: original.schema || undefined,
      actions,
    };
    lines.push(alterTable(spec) + ";");
  }

  // Compute index changes
  const [indexesToDrop, indexesToCreate] = computeIndexDiff(original, modified);

  const tableName = original.schema
    ? `${original.schema}.${original.tableName}`
    : original.tableName;

  for (const idx of indexesToDrop) {
    lines.push("");
    lines.push(dropIndex(idx.name, { ifExists: true }) + ";");
  }

  for (const idx of indexesToCreate) {
    lines.push("");
    lines.push(createIndex(tableName, idx) + ";");
  }

  if (lines.length === 0) {
    return "-- No changes detected";
  }

  return lines.join("\n");
}

/**
 * Check if there are any differences between states.
 */
export function hasChanges(
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
): boolean {
  const actions = computeDiff(original, modified);
  const [toDrop, toCreate] = computeIndexDiff(original, modified);
  return actions.length > 0 || toDrop.length > 0 || toCreate.length > 0;
}
