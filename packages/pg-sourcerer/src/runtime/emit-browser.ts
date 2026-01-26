/**
 * Browser-safe emit service.
 *
 * Identical to emit.ts but avoids Node path utilities and userModule imports.
 */

import type { SymbolStatement } from "../conjure/index";
import * as recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { StatementKind, DeclarationKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Array as Arr, pipe } from "effect";
import type { OrchestratorResult } from "./orchestrator";
import type { SymbolDeclaration, RenderedSymbol, Capability } from "./types";
import type { AssignedSymbol } from "./file-assignment";
import { ExportCollisionError } from "../errors";
import type { UserModuleRef } from "../user-module";

const b = recast.types.builders;

// =============================================================================
// Types
// =============================================================================

/**
 * Check if a node is a SymbolStatement (from conjure exp.* helpers).
 */
function isSymbolStatement(node: unknown): node is SymbolStatement {
  return (
    typeof node === "object" &&
    node !== null &&
    "_tag" in node &&
    (node as { _tag?: string })._tag === "SymbolStatement"
  );
}

/**
 * Unwrap a SymbolStatement to get the underlying statement, or return as-is.
 */
function unwrapNode(node: unknown): unknown {
  if (isSymbolStatement(node)) {
    return node.node;
  }
  return node;
}

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
  /**
   * User module imports for this symbol.
   *
   * Browser emit ignores these.
   */
  readonly userImports?: readonly UserModuleRef[];
  /**
   * @deprecated Use `userImports` instead. Raw code to prepend to the file.
   */
  readonly fileHeader?: string;
}

// =============================================================================
// Emit Configuration
// =============================================================================

export interface EmitConfig {
  /** Header comment to prepend to all files */
  readonly headerComment?: string;
  /**
   * Directory containing the config file.
   * Ignored in browser emit.
   */
  readonly configDir?: string;
  /**
   * Output directory for generated files.
   * Ignored in browser emit.
   */
  readonly outputDir?: string;
}

// =============================================================================
// Emit Logic
// =============================================================================

/**
 * Generate import statement AST from capability references.
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
  const importsBySource = new Map<string, Set<string>>();

  for (const sym of symbolsInFile) {
    const refs = references.get(sym.declaration.capability);
    if (!refs) continue;

    for (const refCap of refs) {
      const location = capToLocation.get(refCap);
      if (!location) continue;

      // Skip if reference is in the same file
      if (location.file === forFile) continue;

      if (!importsBySource.has(location.file)) {
        importsBySource.set(location.file, new Set());
      }
      importsBySource.get(location.file)!.add(location.name);
    }
  }

  const imports: n.ImportDeclaration[] = [];

  for (const [sourceFile, names] of importsBySource) {
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
  const fromParts = fromFile.split("/");
  const toParts = toFile.split("/");

  fromParts.pop();
  const toFileName = toParts.pop()!;

  let commonLen = 0;
  while (
    commonLen < fromParts.length &&
    commonLen < toParts.length &&
    fromParts[commonLen] === toParts[commonLen]
  ) {
    commonLen++;
  }

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
 * Check if a node is already an export declaration.
 */
function isExportDeclaration(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const type = (node as { type?: string }).type;
  return type === "ExportNamedDeclaration" || type === "ExportDefaultDeclaration";
}

/**
 * Build export statement wrapper for a rendered symbol.
 */
function wrapWithExport(node: unknown, exports: RenderedSymbol["exports"]): StatementKind {
  const stmt = node as StatementKind;

  if (exports === undefined || exports === false) {
    return stmt;
  }

  if (isExportDeclaration(node)) {
    return stmt;
  }

  if (exports === "named" || exports === true) {
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

type DeclKind =
  | "const"
  | "let"
  | "var"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "module"
  | "namespace"
  | "import"
  | "export"
  | "other";

/**
 * Extract the declaration kind from an AST node.
 */
function getDeclarationKind(node: unknown): DeclKind {
  if (!node || typeof node !== "object") return "other";

  const n = node as { type?: string; declaration?: unknown };

  if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
    if (n.declaration) {
      return getDeclarationKind(n.declaration);
    }
    return "export";
  }

  if (n.type === "VariableDeclaration") {
    const varNode = node as { kind?: string };
    if (varNode.kind === "let") return "let";
    if (varNode.kind === "var") return "var";
    return "const";
  }
  if (n.type === "FunctionDeclaration") return "function";
  if (n.type === "ClassDeclaration") return "class";
  if (n.type === "TSInterfaceDeclaration") return "interface";
  if (n.type === "TSTypeAliasDeclaration") return "type";
  if (n.type === "TSEnumDeclaration") return "enum";
  if (n.type === "TSModuleDeclaration") return "module";
  if (n.type === "TSNamespaceExportDeclaration") return "namespace";
  if (n.type === "ImportDeclaration") return "import";

  return "other";
}

/**
 * Check if two declaration kinds are compatible.
 */
function areKindsCompatible(kind1: DeclKind, kind2: DeclKind): boolean {
  return kind1 !== kind2;
}

/**
 * Track export collisions for a single file.
 */
function collectStatementsWithCollisionDetection(
  filePath: string,
  symbols: readonly AssignedSymbol[],
  capToRendered: Map<Capability, RenderedSymbol>,
): StatementKind[] {
  const seenExports = new Map<string, { kind: DeclKind; capability: Capability }>();
  const bodyStatements: StatementKind[] = [];

  for (const sym of symbols) {
    const r = capToRendered.get(sym.declaration.capability);
    if (!r) continue;

    if (r.exports === false || r.exports === undefined) {
      continue;
    }

    const wrapped = wrapWithExport(r.node, r.exports);
    const kind = getDeclarationKind(wrapped);

    const existing = seenExports.get(r.name);
    if (existing) {
      if (!areKindsCompatible(existing.kind, kind)) {
        throw new ExportCollisionError({
          file: filePath,
          exportName: r.name,
          exportKind: kind,
          capability1: existing.capability,
          capability2: sym.declaration.capability,
          message: `Export collision in ${filePath}: "${r.name}" is already declared as ${existing.kind}`,
        });
      }
    }

    seenExports.set(r.name, { kind, capability: sym.declaration.capability });

    const unwrapped = unwrapNode(wrapped) as StatementKind;
    bodyStatements.push(unwrapped);
  }

  return bodyStatements;
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

  const capToRendered = new Map<Capability, RenderedSymbol>();
  for (const r of rendered) {
    capToRendered.set(r.capability, r);
  }

  for (const [filePath, symbols] of fileGroups) {
    const crossImports = generateCrossFileImports(
      filePath,
      symbols,
      references,
      fileGroups,
      declarations,
    );

    const externalImportStatements: n.ImportDeclaration[] = [];
    const seenValueImports = new Map<string, Set<string>>();
    const seenTypeImports = new Map<string, Set<string>>();
    const fileHeaders: string[] = [];

    for (const sym of symbols) {
      const r = capToRendered.get(sym.declaration.capability) as
        | RenderedSymbolWithImports
        | undefined;
      if (!r) continue;

      if (r.fileHeader && !fileHeaders.includes(r.fileHeader)) {
        fileHeaders.push(r.fileHeader);
      }

      if (!r.externalImports) continue;

      for (const ext of r.externalImports) {
        if (ext.names) {
          if (!seenValueImports.has(ext.from)) {
            seenValueImports.set(ext.from, new Set());
          }
          for (const n of ext.names) seenValueImports.get(ext.from)!.add(n);
        }
        if (ext.types) {
          if (!seenTypeImports.has(ext.from)) {
            seenTypeImports.set(ext.from, new Set());
          }
          for (const t of ext.types) seenTypeImports.get(ext.from)!.add(t);
        }
      }
    }

    const resolveImportSource = (source: string): string => {
      const isInternalPath =
        source.startsWith("./") ||
        source.startsWith("../") ||
        /\.(ts|js)$/.test(source);

      if (isInternalPath) {
        const normalized = source.replace(/^\.\//, "").replace(/\.js$/, ".ts");
        return computeRelativePath(filePath, normalized);
      }
      return source;
    };

    for (const [source, types] of seenTypeImports) {
      if (types.size > 0) {
        const specifiers = Array.from(types).map(name =>
          b.importSpecifier(b.identifier(name), b.identifier(name)),
        );
        const importDecl = b.importDeclaration(specifiers, b.stringLiteral(resolveImportSource(source)));
        importDecl.importKind = "type";
        externalImportStatements.push(importDecl);
      }
    }

    for (const [source, names] of seenValueImports) {
      if (names.size > 0) {
        const specifiers = Array.from(names).map(name =>
          b.importSpecifier(b.identifier(name), b.identifier(name)),
        );
        externalImportStatements.push(b.importDeclaration(specifiers, b.stringLiteral(resolveImportSource(source))));
      }
    }

    const bodyStatements = collectStatementsWithCollisionDetection(
      filePath,
      symbols,
      capToRendered,
    );

    if (bodyStatements.length === 0) continue;

    const allImports = [...externalImportStatements, ...crossImports];
    const program = b.program([...allImports, ...bodyStatements]);

    let code = recast.print(program).code;
    code = formatCode(code);

    if (fileHeaders.length > 0) {
      code = fileHeaders.join("\n") + "\n\n" + code;
    }

    if (config.headerComment) {
      code = config.headerComment + "\n\n" + code;
    }

    emitted.push({ path: filePath, content: code });
  }

  return emitted;
}
