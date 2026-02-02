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
import recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { StatementKind, DeclarationKind, ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Array as Arr, pipe, Option, Match } from "effect";
import type { OrchestratorResult } from "./orchestrator.js";
import type { RenderedSymbol, Capability } from "./types.js";
import type { AssignedSymbol } from "./file-assignment.js";
import { ExportCollisionError } from "../errors.js";
import { type UserModuleRef, isUserModuleRef } from "../user-module.js";
import conjure from "../conjure/index.js";

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
): n.ImportDeclaration[] {
  // Build a map: capability -> { name, file }
  const capToLocation = pipe(
    Arr.fromIterable(fileGroups.entries()),
    Arr.flatMap(([file, symbols]) =>
      symbols.map(sym => [sym.declaration.capability, { name: sym.declaration.name, file }] as const),
    ),
    entries => new Map<Capability, { name: string; file: string }>(entries),
  );

  // Find all cross-file references from symbols in this file, grouped by source file
  const importsBySource = pipe(
    symbolsInFile,
    Arr.flatMap(sym => {
      const refs = references.get(sym.declaration.capability);
      if (!refs) return [];
      return pipe(
        refs,
        Arr.filterMap(refCap => {
          const location = capToLocation.get(refCap);
          if (!location || location.file === forFile) return Option.none();
          return Option.some({ file: location.file, name: location.name });
        }),
      );
    }),
    Arr.reduce(new Map<string, Set<string>>(), (map, { file, name }) => {
      if (!map.has(file)) map.set(file, new Set());
      map.get(file)!.add(name);
      return map;
    }),
  );

  // Generate import declarations
  return pipe(
    Arr.fromIterable(importsBySource.entries()),
    Arr.map(([sourceFile, names]) => {
      const relativePath = computeRelativePath(forFile, sourceFile);
      const specifiers = Arr.fromIterable(names).map(name =>
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
  const fromParts = fromFile.split("/");
  const toParts = toFile.split("/");

  fromParts.pop(); // Remove filename
  const toFileName = toParts.pop()!; // Get filename

  // Find common prefix length using zip
  const commonLen = pipe(
    Arr.zip(fromParts, toParts),
    Arr.takeWhile(([a, b]) => a === b),
    Arr.length,
  );

  // Build relative path: ".." for each remaining fromPart, then remaining toParts
  const upParts = Arr.replicate("..", fromParts.length - commonLen);
  const downParts = toParts.slice(commonLen);
  const parts = [...upParts, ...downParts, toFileName.replace(/\.ts$/, ".js")];

  // Ensure relative path starts with ./ if not already ../
  return parts[0] !== ".." ? ["..", ...parts].join("/").replace(/^\.\.\//, "./") : parts.join("/");
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
  return pipe(
    path.relative(outputFileDir, userModuleAbsolute),
    // Normalize to forward slashes (for Windows compatibility)
    p => p.split(path.sep).join("/"),
    // Ensure .js extension for imports
    p => p.replace(/\.ts$/, ".js"),
    // Ensure it starts with ./ or ../
    p => (p.startsWith(".") ? p : "./" + p),
  );
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
  const importPath = computeUserModuleImportPath(outputFilePath, ref.path, configDir, outputDir);

  const specifiers: (n.ImportSpecifier | n.ImportDefaultSpecifier | n.ImportNamespaceSpecifier)[] = [
    // Default import: import db from "..."
    ...(ref.default ? [b.importDefaultSpecifier(b.identifier(ref.default))] : []),
    // Namespace import: import * as Db from "..."
    ...(ref.namespace ? [b.importNamespaceSpecifier(b.identifier(ref.namespace))] : []),
    // Named imports: import { foo, bar } from "..."
    ...(ref.named ?? []).map(name => b.importSpecifier(b.identifier(name), b.identifier(name))),
  ];

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
  if (exports === "named") {
    // Recast handles this - we need to wrap in export named declaration
    return b.exportNamedDeclaration(stmt as unknown as DeclarationKind, []);
  }

  if (exports === "default") {
    return b.exportDefaultDeclaration(stmt as unknown as DeclarationKind | ExpressionKind);
  }

  return stmt;
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

/** Map of AST node types to declaration kinds */
const DeclKindMap: Record<string, DeclKind> = {
  FunctionDeclaration: "function",
  ClassDeclaration: "class",
  TSInterfaceDeclaration: "interface",
  TSTypeAliasDeclaration: "type",
  TSEnumDeclaration: "enum",
  TSModuleDeclaration: "module",
  TSNamespaceExportDeclaration: "namespace",
  ImportDeclaration: "import",
};

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

  const n = node as { type?: string; declaration?: unknown; kind?: string };

  // For export declarations, look inside to get the actual declaration kind
  if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
    return n.declaration ? getDeclarationKind(n.declaration) : "export";
  }

  // Variable declarations need special handling for let/var/const
  if (n.type === "VariableDeclaration") {
    return pipe(
      Match.value(n.kind),
      Match.when("let", () => "let" as const),
      Match.when("var", () => "var" as const),
      Match.orElse(() => "const" as const),
    );
  }

  // Use lookup table for other types
  return n.type ? DeclKindMap[n.type] ?? "other" : "other";
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
 *
 * Symbols are emitted in the order they appear in the rendered array,
 * preserving the plugin's intended ordering (e.g., enums before tables).
 */
function collectStatementsWithCollisionDetection(
  filePath: string,
  symbols: readonly AssignedSymbol[],
  capToRendered: Map<Capability, RenderedSymbol>,
  renderedOrder: ReadonlyMap<Capability, number>,
): StatementKind[] {
  const seenExports = new Map<string, { kind: DeclKind; capability: Capability }>();
  const bodyStatements: StatementKind[] = [];

  // Sort symbols by their position in the rendered array
  // This ensures enums come before tables if the plugin rendered them first
  const sortedSymbols = [...symbols].sort((a, b) => {
    const orderA = renderedOrder.get(a.declaration.capability) ?? Number.MAX_SAFE_INTEGER;
    const orderB = renderedOrder.get(b.declaration.capability) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });

  for (const sym of sortedSymbols) {
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

/** Collected import information from symbols */
interface CollectedImports {
  readonly fileHeaders: readonly string[];
  readonly userModuleImports: readonly n.ImportDeclaration[];
  readonly seenValueImports: ReadonlyMap<string, Set<string>>;
  readonly seenTypeImports: ReadonlyMap<string, Set<string>>;
  readonly seenNamespaceImports: ReadonlyMap<string, string>;
  readonly seenDefaultImports: ReadonlyMap<string, string>;
}

/**
 * Collect imports from rendered symbols for a file.
 */
function collectImportsFromSymbols(
  symbols: readonly AssignedSymbol[],
  capToRendered: Map<Capability, RenderedSymbol>,
  filePath: string,
  config: EmitConfig,
): CollectedImports {
  const seenUserModulePaths = new Set<string>();

  return pipe(
    symbols,
    Arr.filterMap(sym => Option.fromNullable(capToRendered.get(sym.declaration.capability))),
    Arr.reduce(
      {
        fileHeaders: [] as string[],
        userModuleImports: [] as n.ImportDeclaration[],
        seenValueImports: new Map<string, Set<string>>(),
        seenTypeImports: new Map<string, Set<string>>(),
        seenNamespaceImports: new Map<string, string>(),
        seenDefaultImports: new Map<string, string>(),
      },
      (acc, r) => {
        // Collect file headers (deduplicated)
        if (r.fileHeader && !acc.fileHeaders.includes(r.fileHeader)) {
          acc.fileHeaders.push(r.fileHeader);
        }

        // Collect user module imports
        if (r.userImports && config.configDir && config.outputDir) {
          r.userImports.forEach(ref => {
            const key = JSON.stringify({
              path: ref.path,
              named: ref.named,
              default: ref.default,
              namespace: ref.namespace,
            });
            if (!seenUserModulePaths.has(key)) {
              seenUserModulePaths.add(key);
              acc.userModuleImports.push(
                generateUserModuleImport(ref, filePath, config.configDir!, config.outputDir!),
              );
            }
          });
        }

        // Collect external imports
        (r.imports ?? []).forEach(ext => {
          if (ext.namespace) acc.seenNamespaceImports.set(ext.from, ext.namespace);
          if (ext.default) acc.seenDefaultImports.set(ext.from, ext.default);
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

  const namespaceImports = pipe(
    Arr.fromIterable(collected.seenNamespaceImports.entries()),
    Arr.map(([source, namespace]) =>
      b.importDeclaration(
        [b.importNamespaceSpecifier(b.identifier(namespace))],
        b.stringLiteral(resolveSource(source)),
      ),
    ),
  );

  const defaultImports = pipe(
    Arr.fromIterable(collected.seenDefaultImports.entries()),
    Arr.map(([source, defaultName]) =>
      b.importDeclaration(
        [b.importDefaultSpecifier(b.identifier(defaultName))],
        b.stringLiteral(resolveSource(source)),
      ),
    ),
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

  return [...typeImports, ...namespaceImports, ...defaultImports, ...valueImports];
}

/**
 * Emit all files from orchestrator result.
 */
export function emitFiles(
  result: OrchestratorResult,
  config: EmitConfig = {},
): readonly EmittedFile[] {
  const { rendered, fileGroups, references } = result;
  const emitted: EmittedFile[] = [];

  // Build maps: capability -> rendered symbol and capability -> render order
  const { capToRendered, renderedOrder } = pipe(
    rendered,
    Arr.reduce(
      {
        capToRendered: new Map<Capability, RenderedSymbol>(),
        renderedOrder: new Map<Capability, number>(),
      },
      (acc, r, i) => {
        acc.capToRendered.set(r.capability, r);
        acc.renderedOrder.set(r.capability, i);
        return acc;
      },
    ),
  );

  // Process each file
  for (const [filePath, symbols] of fileGroups) {
    // Generate cross-file imports
    const crossImports = generateCrossFileImports(
      filePath,
      symbols,
      references,
      fileGroups,
    );

    // Collect imports from rendered symbols
    const collected = collectImportsFromSymbols(symbols, capToRendered, filePath, config);

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
    // This also performs collision detection for same-name exports
    const bodyStatements = collectStatementsWithCollisionDetection(
      filePath,
      symbols,
      capToRendered,
      renderedOrder,
    );

    // Skip files with no body content (provider-only symbols)
    if (bodyStatements.length === 0) continue;

    // Build the program
    // Order: user module imports, external imports, cross-file imports
    const allImports = [...collected.userModuleImports, ...externalImportStatements, ...crossImports];
    const program = b.program([...allImports, ...bodyStatements]);

    // Serialize and add headers
    const baseCode = conjure.print(program);
    const withFileHeaders = collected.fileHeaders.length > 0
      ? collected.fileHeaders.join("\n") + "\n\n" + baseCode
      : baseCode;
    const code = config.headerComment
      ? config.headerComment + "\n\n" + withFileHeaders
      : withFileHeaders;

    emitted.push({ path: filePath, content: code });
  }

  return emitted;
}
