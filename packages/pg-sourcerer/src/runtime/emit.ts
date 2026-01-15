/**
 * Emit Service
 *
 * Takes OrchestratorResult and generates output files:
 * 1. Groups symbols by file (already provided in fileGroups)
 * 2. Generates import statements from cross-reference map
 * 3. Serializes AST to TypeScript code
 * 4. Applies formatting (blank lines before exports, header comments)
 */
import recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { StatementKind, DeclarationKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Array as Arr, pipe } from "effect";
import type { OrchestratorResult } from "./orchestrator.js";
import type { SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import type { AssignedSymbol } from "./file-assignment.js";

const b = recast.types.builders;

// =============================================================================
// Types
// =============================================================================

/**
 * A file ready to be written to disk.
 */
export interface EmittedFile {
  /** Output path relative to outputDir */
  readonly path: string;
  /** Generated TypeScript code */
  readonly content: string;
}

/**
 * External import specification from plugin.
 */
export interface ExternalImport {
  /** Package or relative path */
  readonly from: string;
  /** Named imports */
  readonly names?: readonly string[];
  /** Type-only imports */
  readonly types?: readonly string[];
  /** Default import */
  readonly default?: string;
  /** Namespace import (import * as X) */
  readonly namespace?: string;
}

/**
 * Extended RenderedSymbol with external imports.
 * Plugins can specify external dependencies via this interface.
 */
export interface RenderedSymbolWithImports extends RenderedSymbol {
  /** External imports needed by this symbol */
  readonly externalImports?: readonly ExternalImport[];
}

// =============================================================================
// Emit Configuration
// =============================================================================

export interface EmitConfig {
  /** Header comment to prepend to all files */
  readonly headerComment?: string;
}

// =============================================================================
// Emit Logic
// =============================================================================

/**
 * Generate import statement AST from capability references.
 *
 * Given:
 * - Source file: "types.ts" containing "User" (type:User)
 * - Target file: "schemas.ts" containing "UserSchema" (schema:User)
 * - Reference: schema:User -> type:User
 *
 * Produces import in schemas.ts:
 * import { User } from "./types.js"
 */
function generateCrossFileImports(
  forFile: string,
  symbolsInFile: readonly AssignedSymbol[],
  references: ReadonlyMap<Capability, readonly Capability[]>,
  fileGroups: ReadonlyMap<string, readonly AssignedSymbol[]>,
  allDeclarations: readonly SymbolDeclaration[],
): n.ImportDeclaration[] {
  // Build a map: capability -> { name, file }
  const capToLocation = new Map<Capability, { name: string; file: string }>();
  for (const [file, symbols] of fileGroups) {
    for (const sym of symbols) {
      capToLocation.set(sym.declaration.capability, {
        name: sym.declaration.name,
        file,
      });
    }
  }

  // Collect all capabilities in this file
  const capsInThisFile = new Set(symbolsInFile.map(s => s.declaration.capability));

  // Find all cross-file references from symbols in this file
  // Group by source file
  const importsBySource = new Map<string, Set<string>>();

  for (const sym of symbolsInFile) {
    const refs = references.get(sym.declaration.capability);
    if (!refs) continue;

    for (const refCap of refs) {
      const location = capToLocation.get(refCap);
      if (!location) continue;

      // Skip if reference is in the same file
      if (location.file === forFile) continue;

      // Add to imports
      if (!importsBySource.has(location.file)) {
        importsBySource.set(location.file, new Set());
      }
      importsBySource.get(location.file)!.add(location.name);
    }
  }

  // Generate import declarations
  const imports: n.ImportDeclaration[] = [];

  for (const [sourceFile, names] of importsBySource) {
    // Compute relative path from forFile to sourceFile
    const relativePath = computeRelativePath(forFile, sourceFile);

    const specifiers = Array.from(names).map(name =>
      b.importSpecifier(b.identifier(name), b.identifier(name)),
    );

    imports.push(b.importDeclaration(specifiers, b.stringLiteral(relativePath)));
  }

  return imports;
}

/**
 * Compute relative import path from one file to another.
 * Both paths should be relative to the same base (outputDir).
 */
function computeRelativePath(fromFile: string, toFile: string): string {
  // Simple case: same directory
  const fromParts = fromFile.split("/");
  const toParts = toFile.split("/");

  fromParts.pop(); // Remove filename
  const toFileName = toParts.pop()!; // Get filename

  // Find common prefix
  let commonLen = 0;
  while (
    commonLen < fromParts.length &&
    commonLen < toParts.length &&
    fromParts[commonLen] === toParts[commonLen]
  ) {
    commonLen++;
  }

  // Build relative path
  const upCount = fromParts.length - commonLen;
  const downParts = toParts.slice(commonLen);

  const parts: string[] = [];
  for (let i = 0; i < upCount; i++) {
    parts.push("..");
  }
  parts.push(...downParts);
  parts.push(toFileName.replace(/\.ts$/, ".js"));

  if (parts[0] !== "..") {
    parts.unshift(".");
  }

  return parts.join("/");
}

/**
 * Build export statement wrapper for a rendered symbol.
 */
function wrapWithExport(node: unknown, exports: RenderedSymbol["exports"]): StatementKind {
  const stmt = node as StatementKind;

  // Handle no export case
  if (exports === undefined || exports === false) {
    return stmt;
  }

  // For named exports, we need to add 'export' keyword
  // The node should already be a declaration (type alias, const, function, etc.)
  if (exports === "named" || exports === true) {
    // Recast handles this - we need to wrap in export named declaration
    return b.exportNamedDeclaration(stmt as unknown as DeclarationKind, []);
  }

  if (exports === "default") {
    return b.exportDefaultDeclaration(stmt as unknown as DeclarationKind | ExpressionKind);
  }

  return stmt;
}

/**
 * Format output code:
 * - Ensure blank lines before exports
 */
function formatCode(code: string): string {
  return code
    .split("\n")
    .reduce<string[]>((acc, line) => {
      const prevLine = acc[acc.length - 1];
      const needsBlankLine =
        line.startsWith("export ") && prevLine !== undefined && prevLine !== "";
      return needsBlankLine ? [...acc, "", line] : [...acc, line];
    }, [])
    .join("\n");
}

/**
 * Emit all files from orchestrator result.
 */
export function emitFiles(
  result: OrchestratorResult,
  config: EmitConfig = {},
): readonly EmittedFile[] {
  const { rendered, fileGroups, references, declarations } = result;
  const emitted: EmittedFile[] = [];

  // Build a map: capability -> rendered symbol for lookup
  const capToRendered = new Map<Capability, RenderedSymbol>();
  for (const r of rendered) {
    capToRendered.set(r.capability, r);
  }

  // Process each file
  for (const [filePath, symbols] of fileGroups) {
    // Generate cross-file imports
    const crossImports = generateCrossFileImports(
      filePath,
      symbols,
      references,
      fileGroups,
      declarations,
    );

    // Collect external imports from rendered symbols
    // (if plugins provide them via externalImports field)
    const externalImportStatements: n.ImportDeclaration[] = [];
    const seenExternalSources = new Map<string, Set<string>>();

    for (const sym of symbols) {
      const r = capToRendered.get(sym.declaration.capability) as
        | RenderedSymbolWithImports
        | undefined;
      if (!r?.externalImports) continue;

      for (const ext of r.externalImports) {
        if (!seenExternalSources.has(ext.from)) {
          seenExternalSources.set(ext.from, new Set());
        }
        const names = seenExternalSources.get(ext.from)!;

        // Collect names
        if (ext.names) {
          for (const n of ext.names) names.add(n);
        }
        if (ext.types) {
          for (const t of ext.types) names.add(t); // TODO: separate type imports
        }
      }
    }

    // Build external import statements
    for (const [source, names] of seenExternalSources) {
      if (names.size > 0) {
        const specifiers = Array.from(names).map(name =>
          b.importSpecifier(b.identifier(name), b.identifier(name)),
        );
        externalImportStatements.push(b.importDeclaration(specifiers, b.stringLiteral(source)));
      }
    }

    // Collect rendered bodies for symbols in this file
    const bodyStatements: StatementKind[] = [];
    for (const sym of symbols) {
      const r = capToRendered.get(sym.declaration.capability);
      if (!r) continue;

      const wrapped = wrapWithExport(r.node, r.exports);
      bodyStatements.push(wrapped);
    }

    // Build the program
    const allImports = [...externalImportStatements, ...crossImports];
    const program = b.program([...allImports, ...bodyStatements]);

    // Serialize to code
    let code = recast.print(program).code;

    // Format
    code = formatCode(code);

    // Add header
    if (config.headerComment) {
      code = config.headerComment + "\n\n" + code;
    }

    emitted.push({ path: filePath, content: code });
  }

  return emitted;
}
