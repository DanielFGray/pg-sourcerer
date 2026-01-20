/**
 * Emit Service
 *
 * Takes OrchestratorResult and generates output files:
 * 1. Groups symbols by file (already provided in fileGroups)
 * 2. Generates import statements from cross-reference map
 * 3. Serializes AST to TypeScript code
 * 4. Applies formatting (blank lines before exports, header comments)
 */
import path from "node:path";
import type { SymbolStatement } from "../conjure/index.js";
import recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { StatementKind, DeclarationKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Array as Arr, pipe } from "effect";
import type { OrchestratorResult } from "./orchestrator.js";
import type { SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import type { AssignedSymbol } from "./file-assignment.js";
import { ExportCollisionError } from "../errors.js";
import { type UserModuleRef, isUserModuleRef } from "../user-module.js";

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
   * These are resolved relative to the config file and converted to
   * correct relative paths for each output file at emit time.
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
   * Required for resolving userModule() paths.
   */
  readonly configDir?: string;
  /**
   * Output directory for generated files.
   * Required for computing relative paths from output files to user modules.
   */
  readonly outputDir?: string;
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
 * Compute relative import path from an output file to a user module.
 *
 * @param outputFilePath - Path of the output file relative to outputDir (e.g., "User/queries.ts")
 * @param userModulePath - Path of the user module relative to configDir (e.g., "./db.ts")
 * @param configDir - Absolute path to the directory containing the config file
 * @param outputDir - Output directory path (relative to configDir or absolute)
 * @returns Relative import path with .js extension (e.g., "../../db.js")
 */
function computeUserModuleImportPath(
  outputFilePath: string,
  userModulePath: string,
  configDir: string,
  outputDir: string,
): string {
  // Resolve the absolute path of the user module
  const userModuleAbsolute = path.resolve(configDir, userModulePath);

  // Resolve the absolute path of the output file
  const outputDirAbsolute = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(configDir, outputDir);
  const outputFileAbsolute = path.resolve(outputDirAbsolute, outputFilePath);

  // Get the directory containing the output file
  const outputFileDir = path.dirname(outputFileAbsolute);

  // Compute relative path from output file directory to user module
  let relativePath = path.relative(outputFileDir, userModuleAbsolute);

  // Normalize to forward slashes (for Windows compatibility)
  relativePath = relativePath.split(path.sep).join("/");

  // Ensure .js extension for imports
  relativePath = relativePath.replace(/\.ts$/, ".js");

  // Ensure it starts with ./ or ../
  if (!relativePath.startsWith(".")) {
    relativePath = "./" + relativePath;
  }

  return relativePath;
}

/**
 * Generate import declaration AST for a UserModuleRef.
 */
function generateUserModuleImport(
  ref: UserModuleRef,
  outputFilePath: string,
  configDir: string,
  outputDir: string,
): n.ImportDeclaration {
  const importPath = computeUserModuleImportPath(
    outputFilePath,
    ref.path,
    configDir,
    outputDir,
  );

  const specifiers: (n.ImportSpecifier | n.ImportDefaultSpecifier | n.ImportNamespaceSpecifier)[] = [];

  // Default import: import db from "..."
  if (ref.default) {
    specifiers.push(b.importDefaultSpecifier(b.identifier(ref.default)));
  }

  // Namespace import: import * as Db from "..."
  if (ref.namespace) {
    specifiers.push(b.importNamespaceSpecifier(b.identifier(ref.namespace)));
  }

  // Named imports: import { foo, bar } from "..."
  if (ref.named) {
    for (const name of ref.named) {
      specifiers.push(b.importSpecifier(b.identifier(name), b.identifier(name)));
    }
  }

  return b.importDeclaration(specifiers, b.stringLiteral(importPath));
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

  // Handle no export case
  if (exports === undefined || exports === false) {
    return stmt;
  }

  // If node is already an export declaration, return as-is
  if (isExportDeclaration(node)) {
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
 * Declaration kind for collision detection.
 * Different kinds with the same name can coexist (e.g., const User + type User).
 */
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
 * This is used to detect conflicting declarations.
 *
 * Important: For export declarations, we look inside at the actual
 * declaration to determine the kind. This allows `export const X` and
 * `export type X` to coexist since they're different kinds.
 */
function getDeclarationKind(node: unknown): DeclKind {
  if (!node || typeof node !== "object") return "other";

  const n = node as { type?: string; declaration?: unknown };

  // For export declarations, look inside to get the actual declaration kind
  if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
    if (n.declaration) {
      return getDeclarationKind(n.declaration);
    }
    return "export";
  }

  // Direct declaration types
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
 * Same kinds with the same name would create invalid code.
 * Different kinds (e.g., const + type) can coexist.
 */
function areKindsCompatible(kind1: DeclKind, kind2: DeclKind): boolean {
  return kind1 !== kind2;
}

/**
 * Track export collisions for a single file.
 * Returns the collected statements or throws on collision.
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

    // Skip provider-only symbols (no export, metadata only)
    // These are just for cross-plugin references and don't need to be emitted
    if (r.exports === false || r.exports === undefined) {
      continue;
    }

    const wrapped = wrapWithExport(r.node, r.exports);
    const kind = getDeclarationKind(wrapped);

    // Check for collision
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
      // Compatible different kinds - allow, continue collecting
    }

    seenExports.set(r.name, { kind, capability: sym.declaration.capability });
    bodyStatements.push(wrapped);
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

    // Collect external imports and file headers from rendered symbols
    // Track value imports and type imports separately
    const externalImportStatements: n.ImportDeclaration[] = [];
    const seenValueImports = new Map<string, Set<string>>();
    const seenTypeImports = new Map<string, Set<string>>();
    const fileHeaders: string[] = [];
    const userModuleImports: n.ImportDeclaration[] = [];
    // Track user module refs by their resolved path to dedupe
    const seenUserModulePaths = new Set<string>();

    for (const sym of symbols) {
      const r = capToRendered.get(sym.declaration.capability) as
        | RenderedSymbolWithImports
        | undefined;
      if (!r) continue;

      // Collect file headers (deduplicated) - deprecated, but still supported
      if (r.fileHeader && !fileHeaders.includes(r.fileHeader)) {
        fileHeaders.push(r.fileHeader);
      }

      // Collect user module imports (new system)
      if (r.userImports && config.configDir && config.outputDir) {
        for (const ref of r.userImports) {
          // Create a unique key for deduplication
          const key = JSON.stringify({
            path: ref.path,
            named: ref.named,
            default: ref.default,
            namespace: ref.namespace,
          });
          if (!seenUserModulePaths.has(key)) {
            seenUserModulePaths.add(key);
            userModuleImports.push(
              generateUserModuleImport(ref, filePath, config.configDir, config.outputDir)
            );
          }
        }
      }

      if (!r.externalImports) continue;

      for (const ext of r.externalImports) {
        // Collect value imports
        if (ext.names) {
          if (!seenValueImports.has(ext.from)) {
            seenValueImports.set(ext.from, new Set());
          }
          for (const n of ext.names) seenValueImports.get(ext.from)!.add(n);
        }
        // Collect type imports separately
        if (ext.types) {
          if (!seenTypeImports.has(ext.from)) {
            seenTypeImports.set(ext.from, new Set());
          }
          for (const t of ext.types) seenTypeImports.get(ext.from)!.add(t);
        }
      }
    }

    /**
     * Compute import source path, handling internal vs external packages.
     */
    const resolveImportSource = (source: string): string => {
      // Internal paths:
      // - Start with "./" or ".."
      // - End in .ts/.js (could be "db.ts" or "foo/bar.ts")
      // External packages: "elysia", "@effect/schema", "kysely", etc.
      const isInternalPath =
        source.startsWith("./") ||
        source.startsWith("../") ||
        /\.(ts|js)$/.test(source);

      if (isInternalPath) {
        // Normalize: strip leading "./" if present, convert .js to .ts for path computation
        const normalized = source.replace(/^\.\//, "").replace(/\.js$/, ".ts");
        return computeRelativePath(filePath, normalized);
      }
      return source;
    };

    // Build type-only import statements first
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

    // Build value import statements
    for (const [source, names] of seenValueImports) {
      if (names.size > 0) {
        const specifiers = Array.from(names).map(name =>
          b.importSpecifier(b.identifier(name), b.identifier(name)),
        );
        externalImportStatements.push(b.importDeclaration(specifiers, b.stringLiteral(resolveImportSource(source))));
      }
    }

    // Collect rendered bodies for symbols in this file
    // This also performs collision detection for same-name exports
    const bodyStatements = collectStatementsWithCollisionDetection(
      filePath,
      symbols,
      capToRendered,
    );

    // Skip files with no body content (provider-only symbols)
    if (bodyStatements.length === 0) continue;

    // Build the program
    // Order: user module imports, external imports, cross-file imports
    const allImports = [...userModuleImports, ...externalImportStatements, ...crossImports];
    const program = b.program([...allImports, ...bodyStatements]);

    // Serialize to code
    let code = recast.print(program).code;

    // Format
    code = formatCode(code);

    // Add file-specific headers from plugins (e.g., custom imports)
    if (fileHeaders.length > 0) {
      code = fileHeaders.join("\n") + "\n\n" + code;
    }

    // Add global header comment
    if (config.headerComment) {
      code = config.headerComment + "\n\n" + code;
    }

    emitted.push({ path: filePath, content: code });
  }

  return emitted;
}
