/**
 * Schema Alter TUI
 *
 * Interactive terminal UI for modifying existing database tables.
 * Computes diff and outputs ALTER TABLE statements.
 */
import {
  createCliRenderer,
  ConsolePosition,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type SelectOption,
} from "@opentui/core";

import {
  type SchemaBuilderState,
  type ColumnSpec,
  type ForeignKeySpec,
  type IndexSpec,
  COMMON_PG_TYPES,
  FK_ACTIONS,
  INDEX_METHODS,
} from "./state.js";
import { generateMigrationDDL, hasChanges } from "./diff.js";
import type { SemanticIR, TableEntity } from "../ir/semantic-ir.js";
import { isTableEntity, getTableEntities } from "../ir/semantic-ir.js";
import { tableEntityToState } from "./diff.js";

// =============================================================================
// Types
// =============================================================================

export interface SchemaAlterOptions {
  /** SemanticIR with existing schema (required for alter mode) */
  ir: SemanticIR;
  /** Pre-selected table name (skip table picker) */
  tableName?: string;
}

export interface SchemaAlterResult {
  /** The original state (before changes) */
  originalState: SchemaBuilderState;
  /** The modified state (after changes) */
  modifiedState: SchemaBuilderState;
  /** Generated ALTER DDL */
  ddl: string;
  /** Whether user confirmed (vs cancelled) */
  confirmed: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function opt(name: string, value: any): SelectOption {
  return { name, description: "", value };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Run the schema alter TUI.
 * Returns the diff result, or null if cancelled.
 */
export async function runSchemaAlter(
  options: SchemaAlterOptions,
): Promise<SchemaAlterResult | null> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      startInDebugMode: true,
    },
  });
  renderer.setBackgroundColor("transparent");

  const { ir } = options;

  return new Promise<SchemaAlterResult | null>((resolve) => {
    let cancelled = false;

    (renderer.keyInput as any).on("keypress", (key: any) => {
      if (key.ctrl && key.name === "c") {
        cancelled = true;
        resolve(null);
      }
    });

    runAlterFlow(renderer, ir, options.tableName)
      .then((result) => {
        if (cancelled) return;
        resolve(result);
      })
      .catch((err) => {
        console.error("Schema alter error:", err);
        resolve(null);
      });
  }).finally(() => {
    renderer.destroy();
    renderer.disableStdoutInterception();
  });
}

// =============================================================================
// Alter Flow
// =============================================================================

async function runAlterFlow(
  renderer: CliRenderer,
  ir: SemanticIR,
  preselectedTable?: string,
): Promise<SchemaAlterResult | null> {
  // Build entity map for FK resolution
  const entityMap = new Map<string, TableEntity>();
  for (const [name, entity] of ir.entities) {
    if (isTableEntity(entity)) {
      entityMap.set(name, entity);
    }
  }

  // Step 1: Select table to alter (or use preselected)
  let selectedEntity: TableEntity;
  if (preselectedTable) {
    const found = getTableEntities(ir).find(
      (e) => e.pgName === preselectedTable || e.name === preselectedTable,
    );
    if (!found) {
      return null; // Table not found
    }
    selectedEntity = found;
  } else {
    const entity = await promptSelectTable(renderer, ir);
    if (!entity) return null;
    selectedEntity = entity;
  }

  // Convert to builder state
  const originalState = tableEntityToState(selectedEntity, entityMap);
  const modifiedState = deepClone(originalState);

  // Step 2: Edit loop
  const editResult = await promptEditTable(renderer, originalState, modifiedState, ir);
  if (!editResult) return null;

  // Step 3: Review and confirm
  if (!hasChanges(originalState, modifiedState)) {
    await promptNoChanges(renderer);
    return null;
  }

  const ddl = generateMigrationDDL(originalState, modifiedState);
  const confirmed = await promptReviewAlter(renderer, originalState, modifiedState, ddl);
  if (!confirmed) return null;

  return {
    originalState,
    modifiedState,
    ddl,
    confirmed: true,
  };
}

// =============================================================================
// Step 1: Select Table
// =============================================================================

async function promptSelectTable(
  renderer: CliRenderer,
  ir: SemanticIR,
): Promise<TableEntity | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Select Table to Alter",
      fg: "#fff",
    });

    const tables = getTableEntities(ir);
    const options: SelectOption[] = tables.map((t) =>
      opt(
        `${t.schemaName}.${t.pgName}`,
        t,
      ),
    );

    if (options.length === 0) {
      const noTables = new TextRenderable(renderer, {
        content: "No tables found in the database.",
        fg: "#f00",
      });
      container.add(title);
      container.add(noTables);
      renderer.root.add(container);
      renderer.start();
      setTimeout(() => {
        container.destroyRecursively();
        resolve(null);
      }, 2000);
      return;
    }

    const list = new SelectRenderable(renderer, {
      width: "100%",
      height: Math.min(options.length + 2, 20),
      showScrollIndicator: true,
    });
    list.options = options;

    const helpText = new TextRenderable(renderer, {
      content: "Select a table and press Enter (Ctrl+C to cancel)",
      fg: "#666",
    });

    container.add(title);
    container.add(list);
    container.add(helpText);
    renderer.root.add(container);
    renderer.start();

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const entity = options[idx]?.value as TableEntity;
      container.destroyRecursively();
      resolve(entity);
    });

    list.focus();
  });
}

// =============================================================================
// Step 2: Edit Table
// =============================================================================

type EditAction =
  | "add-column"
  | "drop-column"
  | "edit-column"
  | "add-fk"
  | "drop-fk"
  | "add-index"
  | "drop-index"
  | "done";

async function promptEditTable(
  renderer: CliRenderer,
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
  ir: SemanticIR,
): Promise<boolean> {
  while (true) {
    const action = await promptEditAction(renderer, original, modified);

    if (action === null) return false; // Cancelled
    if (action === "done") return true;

    switch (action) {
      case "add-column": {
        const col = await promptAddColumn(renderer, modified);
        if (col) modified.columns.push(col);
        break;
      }
      case "drop-column": {
        const colName = await promptDropColumn(renderer, modified);
        if (colName) {
          modified.columns = modified.columns.filter((c) => c.name !== colName);
        }
        break;
      }
      case "edit-column": {
        const result = await promptEditColumn(renderer, modified);
        if (result) {
          const idx = modified.columns.findIndex((c) => c.name === result.originalName);
          if (idx >= 0) {
            modified.columns[idx] = result.column;
          }
        }
        break;
      }
      case "add-fk": {
        const fk = await promptAddForeignKey(renderer, modified, ir);
        if (fk) modified.foreignKeys.push(fk);
        break;
      }
      case "drop-fk": {
        const fkName = await promptDropForeignKey(renderer, modified);
        if (fkName) {
          modified.foreignKeys = modified.foreignKeys.filter(
            (fk) => fk.name !== fkName && fk.columns.join(",") !== fkName,
          );
        }
        break;
      }
      case "add-index": {
        const idx = await promptAddIndex(renderer, modified);
        if (idx) modified.indexes.push(idx);
        break;
      }
      case "drop-index": {
        const idxName = await promptDropIndex(renderer, modified);
        if (idxName) {
          modified.indexes = modified.indexes.filter((i) => i.name !== idxName);
        }
        break;
      }
    }
  }
}

async function promptEditAction(
  renderer: CliRenderer,
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
): Promise<EditAction | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "row",
      gap: 2,
      padding: 1,
      height: "100%",
    });

    // Left: Actions
    const actionsBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "40%",
    });

    const title = new TextRenderable(renderer, {
      content: `Alter: ${original.schema}.${original.tableName}`,
      fg: "#fff",
    });

    const options: SelectOption[] = [
      opt("+ Add column", "add-column"),
      opt("- Drop column", "drop-column"),
      opt("~ Edit column", "edit-column"),
      opt("+ Add foreign key", "add-fk"),
      opt("- Drop foreign key", "drop-fk"),
      opt("+ Add index", "add-index"),
      opt("- Drop index", "drop-index"),
      opt("Done", "done"),
    ];

    const list = new SelectRenderable(renderer, {
      width: "100%",
      height: 10,
    });
    list.options = options;

    actionsBox.add(title);
    actionsBox.add(list);

    // Right: Preview
    const previewBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "60%",
      border: true,
      borderStyle: "single",
      borderColor: "#555",
      title: "Migration Preview",
      padding: 1,
    });

    const scrollBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
    });

    const ddl = hasChanges(original, modified)
      ? generateMigrationDDL(original, modified)
      : "-- No changes yet";

    const previewText = new TextRenderable(renderer, {
      content: ddl,
      fg: "#0f0",
      wrapMode: "word",
    });

    scrollBox.add(previewText);
    previewBox.add(scrollBox);

    container.add(actionsBox);
    container.add(previewBox);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const action = options[idx]?.value as EditAction;
      container.destroyRecursively();
      resolve(action);
    });

    list.focus();
  });
}

// =============================================================================
// Column Operations
// =============================================================================

async function promptAddColumn(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<ColumnSpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Add Column", fg: "#fff" });

    const nameLabel = new TextRenderable(renderer, { content: "Name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "column_name",
    });

    const typeLabel = new TextRenderable(renderer, { content: "Type:", fg: "#888" });
    const typeOptions = COMMON_PG_TYPES.map((t) => opt(`${t.type}`, t.type));
    const typeSelect = new SelectRenderable(renderer, { width: 30, height: 6 });
    typeSelect.options = typeOptions;

    const nullableLabel = new TextRenderable(renderer, { content: "Nullable:", fg: "#888" });
    const nullableSelect = new SelectRenderable(renderer, { width: 20, height: 2 });
    nullableSelect.options = [opt("NOT NULL", false), opt("NULLABLE", true)];

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(typeLabel);
    container.add(typeSelect);
    container.add(nullableLabel);
    container.add(nullableSelect);
    renderer.root.add(container);

    // Default to first type in list (matches what's shown selected)
    let pgType: string = COMMON_PG_TYPES[0]?.type ?? "text";
    let nullable = false;

    typeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      pgType = COMMON_PG_TYPES[idx]?.type ?? "text";
    });

    nullableSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      nullable = idx === 1;
    });

    nameInput.on(InputRenderableEvents.ENTER, () => {
      const name = nameInput.value.trim();
      if (name) {
        container.destroyRecursively();
        resolve({ name, pgType, nullable });
      }
    });

    nameInput.focus();
  });
}

async function promptDropColumn(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<string | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Drop Column", fg: "#fff" });

    const options: SelectOption[] = [
      opt("(cancel)", null),
      ...state.columns.map((c) => opt(`${c.name} (${c.pgType})`, c.name)),
    ];

    const list = new SelectRenderable(renderer, {
      width: 40,
      height: Math.min(options.length + 1, 15),
    });
    list.options = options;

    container.add(title);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}

async function promptEditColumn(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<{ originalName: string; column: ColumnSpec } | null> {
  // First select which column to edit
  const colName = await new Promise<string | null>((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Edit Column - Select", fg: "#fff" });

    const options: SelectOption[] = [
      opt("(cancel)", null),
      ...state.columns.map((c) => opt(`${c.name} (${c.pgType})`, c.name)),
    ];

    const list = new SelectRenderable(renderer, {
      width: 40,
      height: Math.min(options.length + 1, 15),
    });
    list.options = options;

    container.add(title);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });

  if (!colName) return null;

  const col = state.columns.find((c) => c.name === colName);
  if (!col) return null;

  // Now edit the column properties
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: `Edit Column: ${col.name}`, fg: "#fff" });

    const nullableLabel = new TextRenderable(renderer, { content: "Nullable:", fg: "#888" });
    const nullableSelect = new SelectRenderable(renderer, { width: 20, height: 2 });
    nullableSelect.options = [opt("NOT NULL", false), opt("NULLABLE", true)];
    nullableSelect.setSelectedIndex(col.nullable ? 1 : 0);

    const confirmOptions: SelectOption[] = [
      opt("Save changes", "save"),
      opt("Cancel", "cancel"),
    ];
    const confirmSelect = new SelectRenderable(renderer, { width: 20, height: 2 });
    confirmSelect.options = confirmOptions;

    container.add(title);
    container.add(nullableLabel);
    container.add(nullableSelect);
    container.add(confirmSelect);
    renderer.root.add(container);

    let nullable = col.nullable;

    nullableSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      nullable = idx === 1;
    });

    confirmSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = confirmSelect.getSelectedIndex();
      const action = confirmOptions[idx]?.value;
      container.destroyRecursively();

      if (action === "save") {
        resolve({
          originalName: colName,
          column: { ...col, nullable },
        });
      } else {
        resolve(null);
      }
    });

    nullableSelect.focus();
  });
}

// =============================================================================
// Foreign Key Operations
// =============================================================================

async function promptAddForeignKey(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir: SemanticIR,
): Promise<ForeignKeySpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Add Foreign Key", fg: "#fff" });

    const sourceLabel = new TextRenderable(renderer, { content: "Source column:", fg: "#888" });
    const sourceOptions = state.columns.map((c) => opt(c.name, c.name));
    const sourceSelect = new SelectRenderable(renderer, { width: 30, height: 5 });
    sourceSelect.options = sourceOptions;

    const targetLabel = new TextRenderable(renderer, { content: "Target table:", fg: "#888" });
    const targetInput = new InputRenderable(renderer, {
      width: 40,
      height: 1,
      padding: 1,
      placeholder: "schema.table_name",
    });

    const targetColLabel = new TextRenderable(renderer, { content: "Target column:", fg: "#888" });
    const targetColInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "id",
    });

    const onDeleteLabel = new TextRenderable(renderer, { content: "ON DELETE:", fg: "#888" });
    const onDeleteOptions: SelectOption[] = [
      opt("(none)", "none"),
      ...FK_ACTIONS.map((a) => opt(a.value.toUpperCase(), a.value)),
    ];
    const onDeleteSelect = new SelectRenderable(renderer, { width: 20, height: 5 });
    onDeleteSelect.options = onDeleteOptions;

    container.add(title);
    container.add(sourceLabel);
    container.add(sourceSelect);
    container.add(targetLabel);
    container.add(targetInput);
    container.add(targetColLabel);
    container.add(targetColInput);
    container.add(onDeleteLabel);
    container.add(onDeleteSelect);
    renderer.root.add(container);

    let sourceColumn = state.columns[0]?.name ?? "";
    let onDelete: ForeignKeySpec["onDelete"] = undefined;

    sourceSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      sourceColumn = sourceOptions[idx]?.value ?? "";
    });

    onDeleteSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      const value = onDeleteOptions[idx]?.value;
      onDelete = value === "none" ? undefined : (value as ForeignKeySpec["onDelete"]);
    });

    targetColInput.on(InputRenderableEvents.ENTER, () => {
      const targetTable = targetInput.value.trim();
      const targetColumn = targetColInput.value.trim() || "id";

      if (sourceColumn && targetTable) {
        container.destroyRecursively();
        resolve({
          columns: [sourceColumn],
          targetTable,
          targetColumns: [targetColumn],
          onDelete,
        });
      }
    });

    sourceSelect.focus();
  });
}

async function promptDropForeignKey(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<string | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Drop Foreign Key", fg: "#fff" });

    const options: SelectOption[] = [
      opt("(cancel)", null),
      ...state.foreignKeys.map((fk) =>
        opt(
          `${fk.columns.join(",")} -> ${fk.targetTable}`,
          fk.name ?? fk.columns.join(","),
        ),
      ),
    ];

    if (options.length === 1) {
      const noFks = new TextRenderable(renderer, {
        content: "No foreign keys to drop.",
        fg: "#888",
      });
      container.add(title);
      container.add(noFks);
      renderer.root.add(container);
      setTimeout(() => {
        container.destroyRecursively();
        resolve(null);
      }, 1500);
      return;
    }

    const list = new SelectRenderable(renderer, {
      width: 50,
      height: Math.min(options.length + 1, 10),
    });
    list.options = options;

    container.add(title);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}

// =============================================================================
// Index Operations
// =============================================================================

async function promptAddIndex(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<IndexSpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Add Index", fg: "#fff" });

    const nameLabel = new TextRenderable(renderer, { content: "Index name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 40,
      height: 1,
      padding: 1,
      placeholder: `idx_${state.tableName}_`,
    });

    const colLabel = new TextRenderable(renderer, { content: "Column:", fg: "#888" });
    const colOptions = state.columns.map((c) => opt(c.name, c.name));
    const colSelect = new SelectRenderable(renderer, { width: 30, height: 5 });
    colSelect.options = colOptions;

    const uniqueLabel = new TextRenderable(renderer, { content: "Unique:", fg: "#888" });
    const uniqueSelect = new SelectRenderable(renderer, { width: 15, height: 2 });
    uniqueSelect.options = [opt("No", false), opt("Yes", true)];

    const methodLabel = new TextRenderable(renderer, { content: "Method:", fg: "#888" });
    const methodOptions = INDEX_METHODS.map((m) => opt(m.value, m.value));
    const methodSelect = new SelectRenderable(renderer, { width: 15, height: 5 });
    methodSelect.options = methodOptions;

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(colLabel);
    container.add(colSelect);
    container.add(uniqueLabel);
    container.add(uniqueSelect);
    container.add(methodLabel);
    container.add(methodSelect);
    renderer.root.add(container);

    let column = state.columns[0]?.name ?? "";
    let unique = false;
    let method: IndexSpec["method"] = "btree";

    colSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      column = colOptions[idx]?.value ?? "";
    });

    uniqueSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      unique = idx === 1;
    });

    methodSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      method = INDEX_METHODS[idx]?.value ?? "btree";
    });

    nameInput.on(InputRenderableEvents.ENTER, () => {
      const name = nameInput.value.trim();
      if (name && column) {
        container.destroyRecursively();
        resolve({ name, columns: [column], unique, method });
      }
    });

    nameInput.focus();
  });
}

async function promptDropIndex(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<string | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, { content: "Drop Index", fg: "#fff" });

    const options: SelectOption[] = [
      opt("(cancel)", null),
      ...state.indexes.map((idx) =>
        opt(`${idx.name}: ${idx.columns.join(", ")}${idx.unique ? " (UNIQUE)" : ""}`, idx.name),
      ),
    ];

    if (options.length === 1) {
      const noIndexes = new TextRenderable(renderer, {
        content: "No indexes to drop.",
        fg: "#888",
      });
      container.add(title);
      container.add(noIndexes);
      renderer.root.add(container);
      setTimeout(() => {
        container.destroyRecursively();
        resolve(null);
      }, 1500);
      return;
    }

    const list = new SelectRenderable(renderer, {
      width: 50,
      height: Math.min(options.length + 1, 10),
    });
    list.options = options;

    container.add(title);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}

// =============================================================================
// Review
// =============================================================================

async function promptNoChanges(renderer: CliRenderer): Promise<void> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "No changes detected.",
      fg: "#888",
    });

    container.add(title);
    renderer.root.add(container);

    setTimeout(() => {
      container.destroyRecursively();
      resolve();
    }, 1500);
  });
}

async function promptReviewAlter(
  renderer: CliRenderer,
  original: SchemaBuilderState,
  modified: SchemaBuilderState,
  ddl: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: `Review Migration: ${original.schema}.${original.tableName}`,
      fg: "#fff",
    });

    const ddlBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "single",
      borderColor: "#555",
      padding: 1,
      width: "100%",
      height: 15,
    });

    const scrollBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
    });

    const ddlText = new TextRenderable(renderer, {
      content: ddl,
      fg: "#0f0",
      wrapMode: "word",
    });

    scrollBox.add(ddlText);
    ddlBox.add(scrollBox);

    const options: SelectOption[] = [
      opt("Confirm - generate migration", true),
      opt("Cancel", false),
    ];

    const list = new SelectRenderable(renderer, { width: 35, height: 3 });
    list.options = options;

    container.add(title);
    container.add(ddlBox);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value ?? false;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}
