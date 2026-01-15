/**
 * File assignment - assigns symbols to output files based on config rules
 *
 * Key insight: config controls file layout, not plugins. Plugins just declare
 * symbols; this module decides where they go based on capability patterns.
 */
import path from "node:path";
import type { SymbolDeclaration, Capability } from "./types.js";

/**
 * A symbol with its assigned output file path.
 */
export interface AssignedSymbol {
  readonly declaration: SymbolDeclaration;
  readonly filePath: string;
}

/**
 * Configuration for file assignment.
 */
export interface FileAssignmentConfig {
  /** Base output directory */
  readonly outputDir: string;

  /**
   * Rules for assigning capabilities to files.
   * Pattern matches capability prefix, path is relative to outputDir.
   * More specific patterns should come first (first match wins).
   */
  readonly rules: readonly FileRule[];

  /** Default file for unmatched symbols */
  readonly defaultFile?: string;
}

/**
 * A rule mapping capability patterns to output files.
 */
export interface FileRule {
  /** Capability pattern to match (prefix matching) */
  readonly pattern: string;
  /** Output file path (relative to outputDir) */
  readonly file: string;
}

/**
 * Assign symbols to output files based on config rules.
 *
 * @example
 * const config = {
 *   outputDir: "src/generated",
 *   rules: [
 *     { pattern: "type:", file: "types.ts" },
 *     { pattern: "schema:zod:", file: "schemas/zod.ts" },
 *   ],
 * }
 * assignSymbolsToFiles(declarations, config)
 */
export function assignSymbolsToFiles(
  declarations: readonly SymbolDeclaration[],
  config: FileAssignmentConfig,
): readonly AssignedSymbol[] {
  return declarations.map((declaration): AssignedSymbol => {
    const filePath = getFileForCapability(declaration.capability, config);
    return { declaration, filePath };
  });
}

/**
 * Group assigned symbols by file path.
 */
export function groupByFile(
  assigned: readonly AssignedSymbol[],
): ReadonlyMap<string, readonly AssignedSymbol[]> {
  const map = new Map<string, AssignedSymbol[]>();

  for (const item of assigned) {
    const existing = map.get(item.filePath);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.filePath, [item]);
    }
  }

  return map;
}

/**
 * Find which file a capability would be assigned to.
 */
export function getFileForCapability(capability: Capability, config: FileAssignmentConfig): string {
  for (const rule of config.rules) {
    if (capability.startsWith(rule.pattern)) {
      return path.join(config.outputDir, rule.file);
    }
  }

  if (config.defaultFile) {
    return path.join(config.outputDir, config.defaultFile);
  }

  throw new Error(
    `No file rule matches capability "${capability}" and no default file is configured`,
  );
}
