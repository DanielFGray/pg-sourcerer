/**
 * Browser-safe emit service.
 *
 * Identical to emit.ts but avoids Node path utilities and userModule imports.
 */

import * as recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { StatementKind, DeclarationKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Array as Arr, Option, pipe } from "effect";
import type { OrchestratorResult } from "./orchestrator";
import type { SymbolDeclaration, RenderedSymbol, Capability } from "./types";
import type { AssignedSymbol } from "./file-assignment";
import { ExportCollisionError } from "../errors";
import conjure from "../conjure";

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
  _allDeclarations: readonly SymbolDeclaration[],
): n.ImportDeclaration[] {
  // Build a map: capability -> { name, file }
  const capToLocation = pipe(
    Arr.fromIterable(fileGroups.entries()),
    Arr.flatMap(([file, symbols]) =>
      symbols.map(sym => [sym.declaration.capability, { name: sym.declaration.name, file }] as const),
    ),
    entries => new Map<Capability, { name: string; file: string }>(entries),
  );

  // Find all cross-file references from symbols in this file
  const importsBySource = pipe(
    symbolsInFile,
    Arr.flatMap(sym => {
      const refs = references.get(sym.declaration.capability);
      return refs ? Arr.fromIterable(refs) : [];
    }),
    Arr.filterMap(refCap => {
      const location = capToLocation.get(refCap);
      if (!location || location.file === forFile) return Option.none();
      return Option.some({ file: location.file, name: location.name });
    }),
    Arr.reduce(new Map<string, Set<string>>(), (acc, { file, name }) => {
      if (!acc.has(file)) acc.set(file, new Set());
      acc.get(file)!.add(name);
      return acc;
    }),
  );

  return pipe(
    Arr.fromIterable(importsBySource.entries()),
    Arr.map(([sourceFile, names]) => {
      const relativePath = computeRelativePath(forFile, sourceFile);
      const specifiers = Array.from(names).map(name =>
        b.importSpecifier(b.identifier(name), b.identifier(name)),
      );
      return b.importDeclaration(specifiers, b.stringLiteral(relativePath));
    }),
  );
}

/**
 * Compute relative import path from one file to another.
 * Both paths should be relative to the same base (outputDir).
 */
function computeRelativePath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/").slice(0, -1); // Remove filename
  const toParts = toFile.split("/");
  const toFileName = toParts.pop()!;

  // Find common prefix length
  const commonLen = pipe(
    Arr.zip(fromParts, toParts),
    Arr.takeWhile(([a, b]) => a === b),
    Arr.length,
  );

  const upCount = fromParts.length - commonLen;
  const downParts = toParts.slice(commonLen);

  const parts = [
    ...Arr.replicate("..", upCount),
    ...downParts,
    toFileName.replace(/\.ts$/, ".js"),
  ];

  return parts[0] !== ".." ? [".", ...parts].join("/") : parts.join("/");
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

  if (exports === "named") {
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

  return pipe(
    symbols,
    Arr.filterMap(sym => {
      const r = capToRendered.get(sym.declaration.capability);
      if (!r || r.exports === false || r.exports === undefined) {
        return Option.none();
      }

      const wrapped = wrapWithExport(r.node, r.exports);
      const kind = getDeclarationKind(wrapped);

      const existing = seenExports.get(r.name);
      if (existing && !areKindsCompatible(existing.kind, kind)) {
        throw new ExportCollisionError({
          file: filePath,
          exportName: r.name,
          exportKind: kind,
          capability1: existing.capability,
          capability2: sym.declaration.capability,
          message: `Export collision in ${filePath}: "${r.name}" is already declared as ${existing.kind}`,
        });
      }

      seenExports.set(r.name, { kind, capability: sym.declaration.capability });
      return Option.some(wrapped);
    }),
  );
}

/** Collected import information from symbols */
interface CollectedImports {
  readonly fileHeaders: readonly string[];
  readonly seenValueImports: ReadonlyMap<string, Set<string>>;
  readonly seenTypeImports: ReadonlyMap<string, Set<string>>;
}

/**
 * Collect imports from rendered symbols for a file.
 */
function collectImportsFromSymbols(
  symbols: readonly AssignedSymbol[],
  capToRendered: Map<Capability, RenderedSymbol>,
): CollectedImports {
  return pipe(
    symbols,
    Arr.filterMap(sym => Option.fromNullable(capToRendered.get(sym.declaration.capability))),
    Arr.reduce(
      {
        fileHeaders: [] as string[],
        seenValueImports: new Map<string, Set<string>>(),
        seenTypeImports: new Map<string, Set<string>>(),
      },
      (acc, r) => {
        // Collect file headers (deduplicated)
        if (r.fileHeader && !acc.fileHeaders.includes(r.fileHeader)) {
          acc.fileHeaders.push(r.fileHeader);
        }

        // Collect external imports
        (r.imports ?? []).forEach(ext => {
          if (ext.names) {
            if (!acc.seenValueImports.has(ext.from)) acc.seenValueImports.set(ext.from, new Set());
            ext.names.forEach(n => acc.seenValueImports.get(ext.from)!.add(n));
          }
          if (ext.types) {
            if (!acc.seenTypeImports.has(ext.from)) acc.seenTypeImports.set(ext.from, new Set());
            ext.types.forEach(t => acc.seenTypeImports.get(ext.from)!.add(t));
          }
        });

        return acc;
      },
    ),
  );
}

/**
 * Build external import declarations from collected imports.
 */
function buildExternalImports(
  collected: CollectedImports,
  resolveSource: (source: string) => string,
): n.ImportDeclaration[] {
  const typeImports = pipe(
    Arr.fromIterable(collected.seenTypeImports.entries()),
    Arr.filter(([, types]) => types.size > 0),
    Arr.map(([source, types]) => {
      const specifiers = Arr.fromIterable(types).map(name =>
        b.importSpecifier(b.identifier(name), b.identifier(name)),
      );
      const decl = b.importDeclaration(specifiers, b.stringLiteral(resolveSource(source)));
      decl.importKind = "type";
      return decl;
    }),
  );

  const valueImports = pipe(
    Arr.fromIterable(collected.seenValueImports.entries()),
    Arr.filter(([, names]) => names.size > 0),
    Arr.map(([source, names]) => {
      const specifiers = Arr.fromIterable(names).map(name =>
        b.importSpecifier(b.identifier(name), b.identifier(name)),
      );
      return b.importDeclaration(specifiers, b.stringLiteral(resolveSource(source)));
    }),
  );

  return [...typeImports, ...valueImports];
}

/**
 * Emit all files from orchestrator result.
 */
export function emitFiles(
  result: OrchestratorResult,
  config: EmitConfig = {},
): readonly EmittedFile[] {
  const { rendered, fileGroups, references, declarations } = result;

  // Build map: capability -> rendered symbol
  const capToRendered = pipe(
    rendered,
    Arr.reduce(new Map<Capability, RenderedSymbol>(), (acc, r) => {
      acc.set(r.capability, r);
      return acc;
    }),
  );

  // Process each file
  return pipe(
    Arr.fromIterable(fileGroups.entries()),
    Arr.filterMap(([filePath, symbols]) => {
      // Generate cross-file imports
      const crossImports = generateCrossFileImports(
        filePath,
        symbols,
        references,
        fileGroups,
        declarations,
      );

      // Collect imports from rendered symbols
      const collected = collectImportsFromSymbols(symbols, capToRendered);

      // Compute import source path, handling internal vs external packages
      const resolveImportSource = (source: string): string => {
        const isInternalPath =
          source.startsWith("./") || source.startsWith("../") || /\.(ts|js)$/.test(source);
        if (isInternalPath) {
          const normalized = source.replace(/^\.\//, "").replace(/\.js$/, ".ts");
          return computeRelativePath(filePath, normalized);
        }
        return source;
      };

      // Build external import declarations
      const externalImportStatements = buildExternalImports(collected, resolveImportSource);

      // Collect rendered bodies for symbols in this file
      const bodyStatements = collectStatementsWithCollisionDetection(
        filePath,
        symbols,
        capToRendered,
      );

      if (bodyStatements.length === 0) return Option.none();

      const allImports = [...externalImportStatements, ...crossImports];
      const program = b.program([...allImports, ...bodyStatements]);

      const code = pipe(
        conjure.print(program),
        code => (collected.fileHeaders.length > 0 ? collected.fileHeaders.join("\n") + "\n\n" + code : code),
        code => (config.headerComment ? config.headerComment + "\n\n" + code : code),
      );

      return Option.some({ path: filePath, content: code });
    }),
  );
}
