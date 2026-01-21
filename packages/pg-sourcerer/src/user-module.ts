/**
 * User Module Reference
 *
 * Provides a structured way to import user-defined modules in generated code.
 * Paths are relative to the config file, and the system computes correct
 * relative imports for each output file at emit time.
 */

/**
 * Reference to a user-defined module for import in generated code.
 *
 * @example
 * ```typescript
 * // In pgsourcerer.config.ts
 * import { userModule } from "pg-sourcerer";
 *
 * kysely({
 *   dbImport: userModule("./db.ts", { named: ["db"] }),
 * })
 * ```
 */
export interface UserModuleRef {
  readonly _tag: "UserModuleRef";
  /** Path to the module, relative to the config file */
  readonly path: string;
  /** Named exports to import: import { foo, bar } from "..." */
  readonly named?: readonly string[];
  /** Default import binding: import db from "..." */
  readonly default?: string;
  /** Namespace import binding: import * as Db from "..." */
  readonly namespace?: string;
  /**
   * Whether to validate that the requested exports exist in the module.
   * @default true
   */
  readonly validate?: boolean;
}

/**
 * Options for creating a user module reference.
 */
export interface UserModuleOptions {
  /** Named exports to import: import { foo, bar } from "..." */
  readonly named?: readonly string[];
  /** Default import binding: import db from "..." */
  readonly default?: string;
  /** Namespace import binding: import * as Db from "..." */
  readonly namespace?: string;
  /**
   * Whether to validate that the requested exports exist in the module.
   * @default true
   */
  readonly validate?: boolean;
}

/**
 * Create a reference to a user module for import in generated code.
 *
 * The path is relative to the config file location. At emit time, the system
 * computes the correct relative import path for each generated file.
 *
 * @param path - Path to the module, relative to the config file
 * @param options - Import options (what to import from the module)
 * @returns A UserModuleRef that can be passed to plugin config
 *
 * @example
 * ```typescript
 * // Named imports
 * userModule("./db.ts", { named: ["db", "Kysely"] })
 * // Generates: import { db, Kysely } from "../db.js"
 *
 * // Default import
 * userModule("./db.ts", { default: "db" })
 * // Generates: import db from "../db.js"
 *
 * // Namespace import
 * userModule("./db.ts", { namespace: "Db" })
 * // Generates: import * as Db from "../db.js"
 *
 * // Skip validation (not recommended)
 * userModule("./db.ts", { named: ["db"], validate: false })
 * ```
 */
export function userModule(path: string, options: UserModuleOptions): UserModuleRef {
  return {
    _tag: "UserModuleRef",
    path,
    named: options.named,
    default: options.default,
    namespace: options.namespace,
    validate: options.validate ?? true,
  };
}

/**
 * Type guard to check if a value is a UserModuleRef.
 */
export function isUserModuleRef(value: unknown): value is UserModuleRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "UserModuleRef"
  );
}
