/**
 * Schema Builder TUI
 *
 * Interactive terminal UI for building database table definitions.
 * Outputs plain SQL DDL files.
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
  type CliRenderer,
  type SelectOption,
} from "@opentui/core";

import {
  type SchemaBuilderState,
  type ColumnSpec,
  type ForeignKeySpec,
  type IndexSpec,
  createInitialState,
  COMMON_PG_TYPES,
  FK_ACTIONS,
  INDEX_METHODS,
} from "./state.js";
import { generateCreateTableDDL } from "./preview.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { isTableEntity } from "../ir/semantic-ir.js";

// =============================================================================
// Database Client Interface (for UUID function detection)
// =============================================================================

/**
 * Minimal database client interface for runtime queries.
 * Compatible with pg.Pool, pg.Client, or any client with a query method.
 */
export interface DatabaseClient {
  query<T = unknown>(sql: string): Promise<{ rows: T[] }>;
}

/**
 * Available UUID generation functions detected from the database.
 */
export interface UuidFunctionInfo {
  name: string;
  expression: string;
  description: string;
  /** Whether this is the recommended default */
  recommended?: boolean;
}

// =============================================================================
// Types
// =============================================================================

export interface SchemaBuilderOptions {
  /** Initial state (for editing existing table) */
  initialState?: Partial<SchemaBuilderState>;
  /** SemanticIR for FK suggestions (optional) */
  ir?: SemanticIR;
  /** Default schema name */
  defaultSchema?: string;
  /** Database client for runtime feature detection (UUID functions, etc.) */
  db?: DatabaseClient;
}

export interface SchemaBuilderResult {
  /** The final state */
  state: SchemaBuilderState;
  /** Generated DDL */
  ddl: string;
  /** Whether user confirmed (vs cancelled) */
  confirmed: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/** Create a select option with empty description (required by opentui) */
function opt(name: string, value: any): SelectOption {
  return { name, description: "", value };
}

// =============================================================================
// UUID Function Detection
// =============================================================================

/** Default UUID functions when no database connection is available */
const DEFAULT_UUID_FUNCTIONS: UuidFunctionInfo[] = [
  {
    name: "gen_random_uuid",
    expression: "gen_random_uuid()",
    description: "Built-in random UUID (v4)",
    recommended: true,
  },
];

/** All known UUID functions to check for */
const KNOWN_UUID_FUNCTIONS = [
  "gen_random_uuid",      // Built-in since PG 13
  "uuid_generate_v4",     // uuid-ossp extension
  "uuid_generate_v7",     // pg_uuidv7 extension
  "uuidv7",               // Alternative pg_uuidv7 function name
];

/**
 * Detect available UUID generation functions from the database.
 * Falls back to defaults if no connection or query fails.
 */
async function detectUuidFunctions(db?: DatabaseClient): Promise<UuidFunctionInfo[]> {
  if (!db) {
    return DEFAULT_UUID_FUNCTIONS;
  }

  try {
    const result = await db.query<{ proname: string }>(
      `SELECT proname FROM pg_proc 
       WHERE proname IN ('gen_random_uuid', 'uuid_generate_v4', 'uuid_generate_v7', 'uuidv7')
       AND pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'public', 'extensions'))`
    );

    const available = new Set(result.rows.map(r => r.proname));
    const functions: UuidFunctionInfo[] = [];

    // UUIDv7 is preferred (time-sortable, better for indexes)
    if (available.has("uuid_generate_v7")) {
      functions.push({
        name: "uuid_generate_v7",
        expression: "uuid_generate_v7()",
        description: "Time-sortable UUID v7 (recommended)",
        recommended: true,
      });
    } else if (available.has("uuidv7")) {
      functions.push({
        name: "uuidv7",
        expression: "uuidv7()",
        description: "Time-sortable UUID v7 (recommended)",
        recommended: true,
      });
    }

    // Built-in gen_random_uuid (PG 13+)
    if (available.has("gen_random_uuid")) {
      functions.push({
        name: "gen_random_uuid",
        expression: "gen_random_uuid()",
        description: "Built-in random UUID v4",
        recommended: functions.length === 0, // Recommend if no v7
      });
    }

    // uuid-ossp extension
    if (available.has("uuid_generate_v4")) {
      functions.push({
        name: "uuid_generate_v4",
        expression: "uuid_generate_v4()",
        description: "Random UUID v4 (uuid-ossp)",
      });
    }

    return functions.length > 0 ? functions : DEFAULT_UUID_FUNCTIONS;
  } catch {
    // Query failed, use defaults
    return DEFAULT_UUID_FUNCTIONS;
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Run the schema builder TUI.
 * Returns the final state and DDL, or null if cancelled.
 */
export async function runSchemaBuilder(
  options: SchemaBuilderOptions = {},
): Promise<SchemaBuilderResult | null> {
  // Detect UUID functions before starting TUI (async, but fast)
  const uuidFunctions = await detectUuidFunctions(options.db);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      startInDebugMode: true,
    },
  });
  renderer.setBackgroundColor("transparent");

  const state = createInitialState({
    schema: options.defaultSchema ?? "public",
    ...options.initialState,
  });

  const ir = options.ir;

  return new Promise<SchemaBuilderResult | null>((resolve) => {
    let cancelled = false;

    // Handle Ctrl+C
    renderer.keyInput.on("keypress", (key: any) => {
      if (key.ctrl && key.name === "c") {
        cancelled = true;
        resolve(null);
      }
    });

    // Run the builder flow
    runBuilderFlow(renderer, state, ir, uuidFunctions)
      .then((result) => {
        if (cancelled) return;
        resolve(result);
      })
      .catch((err) => {
        console.error("Schema builder error:", err);
        resolve(null);
      });
  }).finally(() => {
    renderer.destroy();
    renderer.disableStdoutInterception();
  });
}

// =============================================================================
// Builder Flow
// =============================================================================

async function runBuilderFlow(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
  uuidFunctions: UuidFunctionInfo[] = DEFAULT_UUID_FUNCTIONS,
): Promise<SchemaBuilderResult | null> {
  // Step 1: Table name and schema
  const tableResult = await promptTableName(renderer, state, ir);
  if (!tableResult) return null;
  Object.assign(state, tableResult);

  // Step 2: Primary key strategy (creates PK column(s) automatically)
  const pkResult = await promptPrimaryKeyStrategy(renderer, state, uuidFunctions);
  if (pkResult === null) return null; // cancelled

  // Step 3: Add additional columns
  const columnsResult = await promptColumns(renderer, state, ir);
  if (!columnsResult) return null;
  state.columns = columnsResult.columns;

  // Step 4: Foreign keys (optional)
  const fkResult = await promptForeignKeys(renderer, state, ir);
  if (fkResult === null) return null;
  state.foreignKeys = fkResult;

  // Step 5: Indexes (optional)
  const indexResult = await promptIndexes(renderer, state);
  if (indexResult === null) return null;
  state.indexes = indexResult;

  // Step 6: Review and confirm
  const confirmed = await promptReview(renderer, state);
  if (!confirmed) return null;

  return {
    state,
    ddl: generateCreateTableDDL(state),
    confirmed: true,
  };
}

// =============================================================================
// Step 1: Table Name
// =============================================================================

async function promptTableName(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
): Promise<{ tableName: string; schema: string } | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Create New Table",
      fg: "#fff",
    });

    // Schema selection
    const schemaLabel = new TextRenderable(renderer, {
      content: "Schema:",
      fg: "#888",
    });

    const schemas = ir
      ? Array.from(new Set([...ir.schemas, state.schema]))
      : ["public", "app_public", "app_private"];

    const schemaOptions = schemas.map((s) => opt(s, s));
    const schemaSelect = new SelectRenderable(renderer, {
      width: 30,
      height: Math.min(schemas.length + 1, 5),
    });
    schemaSelect.options = schemaOptions;

    // Table name input
    const nameLabel = new TextRenderable(renderer, {
      content: "Table name:",
      fg: "#888",
    });

    const nameInput = new InputRenderable(renderer, {
      width: 40,
      height: 1,
      padding: 1,
      placeholder: "e.g., users, posts, comments",
    });

    const helpText = new TextRenderable(renderer, {
      content: "Tab to switch fields, Enter to continue (Ctrl+C to cancel)",
      fg: "#666",
    });

    container.add(title);
    container.add(schemaLabel);
    container.add(schemaSelect);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(helpText);

    renderer.root.add(container);
    renderer.start();

    let selectedSchema = state.schema;

    // Tab navigation between focusable elements
    const focusables = [schemaSelect, nameInput];
    let focusIndex = 0;

    const handleTab = (key: any) => {
      if (key.name === "tab") {
        focusIndex = key.shift
          ? (focusIndex - 1 + focusables.length) % focusables.length
          : (focusIndex + 1) % focusables.length;
        focusables[focusIndex]!.focus();
      }
    };
    renderer.keyInput.on("keypress", handleTab);

    schemaSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      selectedSchema = schemas[idx] ?? state.schema;
    });

    // Allow Enter on schema select to move to name input
    schemaSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      focusIndex = 1;
      nameInput.focus();
    });

    nameInput.on(InputRenderableEvents.ENTER, () => {
      const tableName = nameInput.value.trim();
      if (tableName) {
        renderer.keyInput.off("keypress", handleTab);
        container.destroyRecursively();
        resolve({ tableName, schema: selectedSchema });
      }
    });

    schemaSelect.focus();
  });
}

// =============================================================================
// Step 2: Primary Key Strategy
// =============================================================================

/** PK strategy types */
type PkStrategy = "identity-int" | "identity-bigint" | "uuid" | "composite" | "none";

interface PkStrategyResult {
  strategy: PkStrategy;
  columns: ColumnSpec[];
  primaryKey: { columns: string[]; name?: string } | null;
}

/**
 * Prompt user to choose a primary key strategy.
 * This creates the PK column(s) and sets state.primaryKey.
 */
async function promptPrimaryKeyStrategy(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  uuidFunctions: UuidFunctionInfo[],
): Promise<PkStrategyResult | null> {
  // First, choose the strategy
  const strategy = await promptPkStrategyChoice(renderer);
  if (strategy === null) return null;

  if (strategy === "none") {
    return { strategy: "none", columns: [], primaryKey: null };
  }

  if (strategy === "identity-int" || strategy === "identity-bigint") {
    const result = await promptIdentityPk(renderer, state, strategy);
    if (result === null) return null;
    return result;
  }

  if (strategy === "uuid") {
    const result = await promptUuidPk(renderer, state, uuidFunctions);
    if (result === null) return null;
    return result;
  }

  if (strategy === "composite") {
    const result = await promptCompositePk(renderer, state, uuidFunctions);
    if (result === null) return null;
    return result;
  }

  return null;
}

/**
 * Choose PK strategy type
 */
async function promptPkStrategyChoice(renderer: CliRenderer): Promise<PkStrategy | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Primary Key Strategy",
      fg: "#fff",
    });

    const helpText = new TextRenderable(renderer, {
      content: "Choose how to identify rows in this table",
      fg: "#666",
    });

    const options: SelectOption[] = [
      opt("UUID (recommended)", "uuid"),
      opt("Auto-increment (bigint)", "identity-bigint"),
      opt("Auto-increment (integer)", "identity-int"),
      opt("Composite key (multiple columns)", "composite"),
      opt("No primary key", "none"),
    ];

    const list = new SelectRenderable(renderer, {
      width: 45,
      height: options.length + 1,
    });
    list.options = options;

    container.add(title);
    container.add(helpText);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value as PkStrategy;
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}

/**
 * Configure identity (auto-increment) primary key
 */
async function promptIdentityPk(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  strategy: "identity-int" | "identity-bigint",
): Promise<PkStrategyResult | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const baseType = strategy === "identity-bigint" ? "bigint" : "integer";

    const title = new TextRenderable(renderer, {
      content: `Identity Primary Key (${baseType})`,
      fg: "#fff",
    });

    // Column name input
    const nameLabel = new TextRenderable(renderer, { content: "Column name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "id",
    });
    nameInput.value = "id";

    // Generation kind
    const genLabel = new TextRenderable(renderer, { content: "Generation:", fg: "#888" });
    const genOptions: SelectOption[] = [
      opt("ALWAYS (recommended)", "always"),
      opt("BY DEFAULT (allows manual override)", "by default"),
    ];
    const genSelect = new SelectRenderable(renderer, { width: 45, height: 3 });
    genSelect.options = genOptions;

    const helpText = new TextRenderable(renderer, {
      content: "Tab to switch fields, Enter to confirm",
      fg: "#666",
    });

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(genLabel);
    container.add(genSelect);
    container.add(helpText);
    renderer.root.add(container);

    let generationKind: "always" | "by default" = "always";

    // Tab navigation
    const focusables = [nameInput, genSelect];
    let focusIndex = 0;

    const handleTab = (key: any) => {
      if (key.name === "tab") {
        focusIndex = key.shift
          ? (focusIndex - 1 + focusables.length) % focusables.length
          : (focusIndex + 1) % focusables.length;
        focusables[focusIndex]!.focus();
      }
    };
    renderer.keyInput.on("keypress", handleTab);

    const cleanup = () => {
      renderer.keyInput.off("keypress", handleTab);
      container.destroyRecursively();
    };

    genSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      generationKind = idx === 0 ? "always" : "by default";
    });

    // Enter on name input moves to gen select
    nameInput.on(InputRenderableEvents.ENTER, () => {
      focusIndex = 1;
      genSelect.focus();
    });

    // Enter on gen select confirms
    genSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const columnName = nameInput.value.trim() || "id";
      cleanup();

      const column: ColumnSpec = {
        name: columnName,
        pgType: baseType,
        nullable: false,
        isIdentity: true,
        generationKind,
      };

      // Add to state
      state.columns.push(column);
      state.primaryKey = { columns: [columnName] };

      resolve({
        strategy,
        columns: [column],
        primaryKey: { columns: [columnName] },
      });
    });

    nameInput.focus();
  });
}

/**
 * Configure UUID primary key
 */
async function promptUuidPk(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  uuidFunctions: UuidFunctionInfo[],
): Promise<PkStrategyResult | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "UUID Primary Key",
      fg: "#fff",
    });

    // Column name input
    const nameLabel = new TextRenderable(renderer, { content: "Column name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "id",
    });
    nameInput.value = "id";

    // UUID function selection
    const funcLabel = new TextRenderable(renderer, { content: "Default function:", fg: "#888" });
    const funcOptions: SelectOption[] = uuidFunctions.map((f) =>
      opt(f.recommended ? `${f.name} (recommended)` : f.name, f.expression),
    );
    const funcSelect = new SelectRenderable(renderer, {
      width: 45,
      height: Math.min(uuidFunctions.length + 1, 5),
    });
    funcSelect.options = funcOptions;

    const helpText = new TextRenderable(renderer, {
      content: "Tab to switch fields, Enter to confirm",
      fg: "#666",
    });

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(funcLabel);
    container.add(funcSelect);
    container.add(helpText);
    renderer.root.add(container);

    let defaultExpression = uuidFunctions[0]?.expression ?? "gen_random_uuid()";

    // Tab navigation
    const focusables = [nameInput, funcSelect];
    let focusIndex = 0;

    const handleTab = (key: any) => {
      if (key.name === "tab") {
        focusIndex = key.shift
          ? (focusIndex - 1 + focusables.length) % focusables.length
          : (focusIndex + 1) % focusables.length;
        focusables[focusIndex]!.focus();
      }
    };
    renderer.keyInput.on("keypress", handleTab);

    const cleanup = () => {
      renderer.keyInput.off("keypress", handleTab);
      container.destroyRecursively();
    };

    funcSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      defaultExpression = uuidFunctions[idx]?.expression ?? "gen_random_uuid()";
    });

    // Enter on name input moves to func select
    nameInput.on(InputRenderableEvents.ENTER, () => {
      focusIndex = 1;
      funcSelect.focus();
    });

    // Enter on func select confirms
    funcSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const columnName = nameInput.value.trim() || "id";
      cleanup();

      const column: ColumnSpec = {
        name: columnName,
        pgType: "uuid",
        nullable: false,
        hasDefault: true,
        defaultValue: defaultExpression,
      };

      // Add to state
      state.columns.push(column);
      state.primaryKey = { columns: [columnName] };

      resolve({
        strategy: "uuid",
        columns: [column],
        primaryKey: { columns: [columnName] },
      });
    });

    nameInput.focus();
  });
}

/**
 * Configure composite primary key (multiple columns)
 */
async function promptCompositePk(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  uuidFunctions: UuidFunctionInfo[],
): Promise<PkStrategyResult | null> {
  const pkColumns: ColumnSpec[] = [];

  // Add columns until user says done
  while (true) {
    const action = await promptCompositePkAction(renderer, pkColumns);

    if (action === null) return null; // cancelled
    if (action === "done") {
      if (pkColumns.length < 2) {
        // Need at least 2 columns for composite
        continue;
      }
      break;
    }

    if (action === "add") {
      const colResult = await promptCompositePkColumn(renderer, uuidFunctions);
      if (colResult) {
        pkColumns.push(colResult);
      }
    }
  }

  // Add all columns to state
  for (const col of pkColumns) {
    state.columns.push(col);
  }
  state.primaryKey = { columns: pkColumns.map((c) => c.name) };

  return {
    strategy: "composite",
    columns: pkColumns,
    primaryKey: { columns: pkColumns.map((c) => c.name) },
  };
}

async function promptCompositePkAction(
  renderer: CliRenderer,
  pkColumns: ColumnSpec[],
): Promise<"add" | "done" | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: `Composite Primary Key (${pkColumns.length} columns)`,
      fg: "#fff",
    });

    const currentCols =
      pkColumns.length > 0
        ? new TextRenderable(renderer, {
            content: `Current: (${pkColumns.map((c) => c.name).join(", ")})`,
            fg: "#888",
          })
        : new TextRenderable(renderer, {
            content: "Add at least 2 columns",
            fg: "#666",
          });

    const options: SelectOption[] = [
      opt("+ Add column to PK", "add"),
      ...(pkColumns.length >= 2 ? [opt("Done", "done")] : []),
    ];

    const list = new SelectRenderable(renderer, {
      width: 40,
      height: options.length + 1,
    });
    list.options = options;

    container.add(title);
    container.add(currentCols);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value as "add" | "done";
      container.destroyRecursively();
      resolve(value);
    });

    list.focus();
  });
}

async function promptCompositePkColumn(
  renderer: CliRenderer,
  uuidFunctions: UuidFunctionInfo[],
): Promise<ColumnSpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Add Column to Composite PK",
      fg: "#fff",
    });

    // Column name
    const nameLabel = new TextRenderable(renderer, { content: "Column name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "column_name",
    });

    // Type selection (limited to PK-suitable types)
    const typeLabel = new TextRenderable(renderer, { content: "Type:", fg: "#888" });
    const typeOptions: SelectOption[] = [
      opt("uuid", "uuid"),
      opt("bigint", "bigint"),
      opt("integer", "integer"),
      opt("text", "text"),
    ];
    const typeSelect = new SelectRenderable(renderer, { width: 30, height: 5 });
    typeSelect.options = typeOptions;

    const helpText = new TextRenderable(renderer, {
      content: "Tab to switch fields, Enter to confirm",
      fg: "#666",
    });

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(typeLabel);
    container.add(typeSelect);
    container.add(helpText);
    renderer.root.add(container);

    let pgType = "uuid";

    // Tab navigation
    const focusables = [nameInput, typeSelect];
    let focusIndex = 0;

    const handleTab = (key: any) => {
      if (key.name === "tab") {
        focusIndex = key.shift
          ? (focusIndex - 1 + focusables.length) % focusables.length
          : (focusIndex + 1) % focusables.length;
        focusables[focusIndex]!.focus();
      }
    };
    renderer.keyInput.on("keypress", handleTab);

    const cleanup = () => {
      renderer.keyInput.off("keypress", handleTab);
      container.destroyRecursively();
    };

    typeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      pgType = typeOptions[idx]?.value ?? "uuid";
    });

    // Enter on name moves to type
    nameInput.on(InputRenderableEvents.ENTER, () => {
      focusIndex = 1;
      typeSelect.focus();
    });

    // Enter on type confirms
    typeSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const columnName = nameInput.value.trim();
      if (!columnName) return; // Need a name

      cleanup();

      const column: ColumnSpec = {
        name: columnName,
        pgType,
        nullable: false,
      };

      // Add default for UUID
      if (pgType === "uuid" && uuidFunctions.length > 0) {
        column.hasDefault = true;
        column.defaultValue = uuidFunctions[0]?.expression ?? "gen_random_uuid()";
      }

      resolve(column);
    });

    nameInput.focus();
  });
}

// =============================================================================
// Step 3: Additional Columns
// =============================================================================

async function promptColumns(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
): Promise<{ columns: ColumnSpec[] } | null> {
  const columns: ColumnSpec[] = [...state.columns];

  while (true) {
    const action = await promptColumnAction(renderer, state, columns);

    if (action === null) {
      return null;
    }

    if (action === "done") {
      if (columns.length === 0) {
        continue;
      }
      return { columns };
    }

    if (action === "add") {
      const newColumn = await promptAddColumn(renderer, state, ir);
      if (newColumn) {
        columns.push(newColumn);
      }
    }

    if (typeof action === "number") {
      const edited = await promptEditColumn(renderer, columns[action]!, ir);
      if (edited === "delete") {
        columns.splice(action, 1);
      } else if (edited) {
        columns[action] = edited;
      }
    }
  }
}

async function promptColumnAction(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  columns: ColumnSpec[],
): Promise<"add" | "done" | number | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "row",
      gap: 2,
      padding: 1,
      height: "100%",
    });

    // Left side: column list
    const listBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 0,
      width: "50%",
    });

    const listTitle = new TextRenderable(renderer, {
      content: `Columns (${columns.length})`,
      fg: "#fff",
    });

    const options: SelectOption[] = [
      opt("+ Add column", "add"),
      ...columns.map((c, i) =>
        opt(`${c.name} (${c.pgType}${c.nullable === false ? " NOT NULL" : ""})`, i),
      ),
      opt("Done adding columns", "done"),
    ];

    const list = new SelectRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      wrapSelection: true,
    });
    list.options = options;

    listBox.add(listTitle);
    listBox.add(list);

    // Right side: DDL preview
    const previewBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "50%",
      border: true,
      borderStyle: "single",
      borderColor: "#555",
      title: "DDL Preview",
      padding: 1,
    });

    const previewState = { ...state, columns };
    const previewText = new TextRenderable(renderer, {
      content: generateCreateTableDDL(previewState),
      fg: "#aaa",
      wrapMode: "word",
    });

    previewBox.add(previewText);

    container.add(listBox);
    container.add(previewBox);

    renderer.root.add(container);

    const handleSelect = () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();
      if (value === "add") resolve("add");
      else if (value === "done") resolve("done");
      else if (typeof value === "number") resolve(value);
      else resolve(null);
    };

    list.on(SelectRenderableEvents.ITEM_SELECTED, handleSelect);
    list.focus();
  });
}

async function promptAddColumn(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
): Promise<ColumnSpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Add Column",
      fg: "#fff",
    });

    // Name input
    const nameLabel = new TextRenderable(renderer, { content: "Name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "column_name",
    });

    // Type selection
    const typeLabel = new TextRenderable(renderer, { content: "Type:", fg: "#888" });
    const typeOptions = COMMON_PG_TYPES.map((t) => opt(`${t.type} - ${t.description}`, t.type));
    const typeSelect = new SelectRenderable(renderer, {
      width: 50,
      height: 8,
      showDescription: false,
    });
    typeSelect.options = typeOptions;

    // Options
    const optionsLabel = new TextRenderable(renderer, { content: "Options:", fg: "#888" });
    const nullableSelect = new SelectRenderable(renderer, { width: 20, height: 2 });
    nullableSelect.options = [opt("NOT NULL", false), opt("NULLABLE", true)];

    const helpText = new TextRenderable(renderer, {
      content: "Tab to switch fields, Enter on last field to confirm.",
      fg: "#666",
    });

    container.add(title);
    container.add(nameLabel);
    container.add(nameInput);
    container.add(typeLabel);
    container.add(typeSelect);
    container.add(optionsLabel);
    container.add(nullableSelect);
    container.add(helpText);

    renderer.root.add(container);

    let name = "";
    let pgType = "text";
    let nullable = false;

    // Tab navigation between focusable elements
    const focusables = [nameInput, typeSelect, nullableSelect];
    let focusIndex = 0;

    const handleTab = (key: any) => {
      if (key.name === "tab") {
        focusIndex = key.shift
          ? (focusIndex - 1 + focusables.length) % focusables.length
          : (focusIndex + 1) % focusables.length;
        focusables[focusIndex]!.focus();
      }
    };
    renderer.keyInput.on("keypress", handleTab);

    const cleanup = () => {
      renderer.keyInput.off("keypress", handleTab);
      container.destroyRecursively();
    };

    nameInput.on(InputRenderableEvents.INPUT, (val: string) => {
      name = val;
    });

    typeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      pgType = COMMON_PG_TYPES[idx]?.type ?? "text";
    });

    nullableSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
      nullable = idx === 1;
    });

    // Enter on name input moves to type select
    nameInput.on(InputRenderableEvents.ENTER, () => {
      name = nameInput.value.trim();
      if (name) {
        focusIndex = 1;
        typeSelect.focus();
      }
    });

    // Enter on type select moves to nullable select
    typeSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      focusIndex = 2;
      nullableSelect.focus();
    });

    // Enter on nullable select confirms
    nullableSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      name = nameInput.value.trim();
      if (name) {
        cleanup();
        resolve({ name, pgType, nullable });
      }
    });

    nameInput.focus();
  });
}

async function promptEditColumn(
  renderer: CliRenderer,
  column: ColumnSpec,
  ir?: SemanticIR,
): Promise<ColumnSpec | "delete" | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: `Edit Column: ${column.name}`,
      fg: "#fff",
    });

    const options: SelectOption[] = [
      opt("Save changes", "save"),
      opt("Delete column", "delete"),
      opt("Cancel", "cancel"),
    ];

    const list = new SelectRenderable(renderer, { width: 30, height: 4 });
    list.options = options;

    container.add(title);
    container.add(list);
    renderer.root.add(container);

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const idx = list.getSelectedIndex();
      const value = options[idx]?.value;
      container.destroyRecursively();

      if (value === "delete") resolve("delete");
      else if (value === "save") resolve(column);
      else resolve(null);
    });

    list.focus();
  });
}

// =============================================================================
// Step 4: Foreign Keys
// =============================================================================

async function promptForeignKeys(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
): Promise<ForeignKeySpec[] | null> {
  const foreignKeys: ForeignKeySpec[] = [...state.foreignKeys];

  while (true) {
    const action = await promptForeignKeyAction(renderer, state, foreignKeys, ir);

    if (action === null) return null;
    if (action === "done") return foreignKeys;

    if (action === "add") {
      const newFk = await promptAddForeignKey(renderer, state, ir);
      if (newFk) {
        foreignKeys.push(newFk);
      }
    }
  }
}

async function promptForeignKeyAction(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  foreignKeys: ForeignKeySpec[],
  ir?: SemanticIR,
): Promise<"add" | "done" | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: `Foreign Keys (${foreignKeys.length})`,
      fg: "#fff",
    });

    const options: SelectOption[] = [
      opt("+ Add foreign key", "add"),
      ...foreignKeys.map((fk) =>
        opt(`${fk.columns.join(", ")} -> ${fk.targetTable}(${fk.targetColumns.join(", ")})`, "view"),
      ),
      opt("Done (continue)", "done"),
    ];

    const list = new SelectRenderable(renderer, {
      width: 60,
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

      if (value === "add") resolve("add");
      else if (value === "done") resolve("done");
      else resolve(null);
    });

    list.focus();
  });
}

async function promptAddForeignKey(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  ir?: SemanticIR,
): Promise<ForeignKeySpec | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Add Foreign Key",
      fg: "#fff",
    });

    // Source column selection
    const sourceLabel = new TextRenderable(renderer, { content: "Source column:", fg: "#888" });
    const sourceOptions = state.columns.map((c) => opt(c.name, c.name));
    const sourceSelect = new SelectRenderable(renderer, { width: 30, height: 5 });
    sourceSelect.options = sourceOptions;

    // Target table
    const targetLabel = new TextRenderable(renderer, { content: "Target table:", fg: "#888" });

    let targetTables: string[] = [];
    if (ir) {
      targetTables = Array.from(ir.entities.values())
        .filter(isTableEntity)
        .map((e) => (e.schemaName !== "public" ? `${e.schemaName}.${e.pgName}` : e.pgName));
    }

    const targetInput = new InputRenderable(renderer, {
      width: 40,
      height: 1,
      padding: 1,
      placeholder: "schema.table_name",
    });

    // Target column
    const targetColLabel = new TextRenderable(renderer, { content: "Target column:", fg: "#888" });
    const targetColInput = new InputRenderable(renderer, {
      width: 30,
      height: 1,
      padding: 1,
      placeholder: "id",
    });

    // ON DELETE action
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

// =============================================================================
// Step 5: Indexes
// =============================================================================

async function promptIndexes(
  renderer: CliRenderer,
  state: SchemaBuilderState,
): Promise<IndexSpec[] | null> {
  const indexes: IndexSpec[] = [...state.indexes];

  while (true) {
    const action = await promptIndexAction(renderer, state, indexes);

    if (action === null) return null;
    if (action === "done") return indexes;

    if (action === "add") {
      const newIndex = await promptAddIndex(renderer, state);
      if (newIndex) {
        indexes.push(newIndex);
      }
    }
  }
}

async function promptIndexAction(
  renderer: CliRenderer,
  state: SchemaBuilderState,
  indexes: IndexSpec[],
): Promise<"add" | "done" | null> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: `Indexes (${indexes.length})`,
      fg: "#fff",
    });

    const options: SelectOption[] = [
      opt("+ Add index", "add"),
      ...indexes.map((idx) =>
        opt(`${idx.name}: ${idx.columns.join(", ")}${idx.unique ? " (UNIQUE)" : ""}`, "view"),
      ),
      opt("Done (continue)", "done"),
    ];

    const list = new SelectRenderable(renderer, {
      width: 60,
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

      if (value === "add") resolve("add");
      else if (value === "done") resolve("done");
      else resolve(null);
    });

    list.focus();
  });
}

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

    const title = new TextRenderable(renderer, {
      content: "Add Index",
      fg: "#fff",
    });

    // Index name
    const nameLabel = new TextRenderable(renderer, { content: "Index name:", fg: "#888" });
    const nameInput = new InputRenderable(renderer, {
      width: 40,
      height: 1,
      padding: 1,
      placeholder: `idx_${state.tableName}_`,
    });

    // Column selection
    const colLabel = new TextRenderable(renderer, { content: "Column:", fg: "#888" });
    const colOptions = state.columns.map((c) => opt(c.name, c.name));
    const colSelect = new SelectRenderable(renderer, { width: 30, height: 5 });
    colSelect.options = colOptions;

    // Unique checkbox
    const uniqueLabel = new TextRenderable(renderer, { content: "Unique:", fg: "#888" });
    const uniqueSelect = new SelectRenderable(renderer, { width: 15, height: 2 });
    uniqueSelect.options = [opt("No", false), opt("Yes", true)];

    // Method
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

// =============================================================================
// Step 6: Review
// =============================================================================

async function promptReview(renderer: CliRenderer, state: SchemaBuilderState): Promise<boolean> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    const title = new TextRenderable(renderer, {
      content: "Review Generated DDL",
      fg: "#fff",
    });

    const ddlBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "single",
      borderColor: "#555",
      padding: 1,
      width: "100%",
      height: 20,
    });

    const ddlText = new TextRenderable(renderer, {
      content: generateCreateTableDDL(state),
      fg: "#0f0",
      wrapMode: "word",
    });

    ddlBox.add(ddlText);

    const options: SelectOption[] = [
      opt("Confirm - generate file", true),
      opt("Cancel", false),
    ];

    const list = new SelectRenderable(renderer, { width: 30, height: 3 });
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
