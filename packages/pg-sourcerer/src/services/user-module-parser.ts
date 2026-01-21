/**
 * User Module Parser Service
 *
 * Parses TypeScript/JavaScript files to extract export information.
 * Used to validate that userModule() references point to valid exports.
 */
import { parse, type ParserPlugin } from "@babel/parser";
import { Context, Effect, Layer, pipe, Array as Arr } from "effect";
import { FileSystem } from "@effect/platform";
import {
  UserModuleParseError,
  ExportNotFoundError,
  UserModuleNotFoundError,
} from "../errors.js";
import type { UserModuleRef } from "../user-module.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Information about exports found in a module.
 */
export interface UserModuleExports {
  /** Named exports: export const foo, export { bar }, export function baz */
  readonly named: readonly string[];
  /** Whether the module has a default export */
  readonly hasDefault: boolean;
}

// =============================================================================
// Service Definition
// =============================================================================

/**
 * Service for parsing user modules and extracting export information.
 */
export interface UserModuleParser {
  /**
   * Parse a TypeScript/JavaScript file and extract its exports.
   *
   * @param absolutePath - Absolute path to the file to parse
   * @returns Export information for the module
   */
  readonly parseExports: (
    absolutePath: string
  ) => Effect.Effect<
    UserModuleExports,
    UserModuleParseError | UserModuleNotFoundError,
    FileSystem.FileSystem
  >;

  /**
   * Validate that a UserModuleRef's requested imports exist in the module.
   *
   * @param absolutePath - Absolute path to the module file
   * @param ref - The UserModuleRef specifying what to import
   * @returns void on success, fails with ExportNotFoundError if any import is missing
   */
  readonly validateImports: (
    absolutePath: string,
    ref: UserModuleRef
  ) => Effect.Effect<
    void,
    UserModuleParseError | UserModuleNotFoundError | ExportNotFoundError,
    FileSystem.FileSystem
  >;
}

export class UserModuleParserService extends Context.Tag("UserModuleParser")<
  UserModuleParserService,
  UserModuleParser
>() {}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Determine babel parser plugins based on file extension.
 */
function getParserPlugins(filePath: string): ParserPlugin[] {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const plugins: ParserPlugin[] = [];

  if (ext === "ts" || ext === "tsx") {
    plugins.push("typescript");
  }
  if (ext === "tsx" || ext === "jsx") {
    plugins.push("jsx");
  }

  return plugins;
}

/**
 * Normalize a file path for lookup - try .ts first, then .js
 */
function normalizeFilePath(filePath: string): string[] {
  // If already has extension, also try the other
  if (filePath.endsWith(".js")) {
    return [filePath.replace(/\.js$/, ".ts"), filePath];
  }
  if (filePath.endsWith(".ts")) {
    return [filePath, filePath.replace(/\.ts$/, ".js")];
  }
  // No extension - try .ts first, then .js
  return [`${filePath}.ts`, `${filePath}.js`, filePath];
}

/**
 * Extract export names from parsed AST.
 */
function extractExports(
  ast: ReturnType<typeof parse>
): UserModuleExports {
  const named: string[] = [];
  let hasDefault = false;

  for (const node of ast.program.body) {
    switch (node.type) {
      case "ExportNamedDeclaration": {
        // export const foo = ..., export function bar() {}, export class Baz {}
        if (node.declaration) {
          const decl = node.declaration;
          if (
            decl.type === "VariableDeclaration"
          ) {
            for (const d of decl.declarations) {
              if (d.id.type === "Identifier") {
                named.push(d.id.name);
              }
            }
          } else if (
            decl.type === "FunctionDeclaration" ||
            decl.type === "ClassDeclaration" ||
            decl.type === "TSTypeAliasDeclaration" ||
            decl.type === "TSInterfaceDeclaration" ||
            decl.type === "TSEnumDeclaration"
          ) {
            if (decl.id) {
              named.push(decl.id.name);
            }
          }
        }
        // export { foo, bar } or export { foo, bar } from "./other"
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (spec.type === "ExportSpecifier") {
              // Use the exported name (could be renamed: export { foo as bar })
              const exportedName =
                spec.exported.type === "Identifier"
                  ? spec.exported.name
                  : spec.exported.value;
              named.push(exportedName);
            }
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        hasDefault = true;
        break;
      }
      // Note: We explicitly don't follow ExportAllDeclaration (export * from "./other")
      // as per design decision to only check direct exports
    }
  }

  return { named, hasDefault };
}

/**
 * Create a UserModuleParser implementation.
 */
export function createUserModuleParser(): UserModuleParser {
  return {
    parseExports: absolutePath =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Try normalized paths (.ts first, then .js)
        const pathsToTry = normalizeFilePath(absolutePath);
        let content: string | null = null;
        let resolvedPath: string = absolutePath;

        for (const tryPath of pathsToTry) {
          const exists = yield* pipe(
            fs.exists(tryPath),
            Effect.orElseSucceed(() => false)
          );
          if (exists) {
            content = yield* pipe(
              fs.readFileString(tryPath),
              Effect.mapError(
                cause =>
                  new UserModuleParseError({
                    message: `Failed to read file: ${tryPath}`,
                    path: tryPath,
                    cause,
                  })
              )
            );
            resolvedPath = tryPath;
            break;
          }
        }

        if (content === null) {
          return yield* Effect.fail(
            new UserModuleNotFoundError({
              message: `User module not found: ${absolutePath}`,
              configPath: absolutePath,
              resolvedPath: pathsToTry[0] ?? absolutePath,
            })
          );
        }

        // Parse the file
        let ast: ReturnType<typeof parse>;
        try {
          ast = parse(content, {
            sourceType: "module",
            plugins: getParserPlugins(resolvedPath),
            // Be lenient with parsing errors for better UX
            errorRecovery: true,
          });
        } catch (error) {
          return yield* Effect.fail(
            new UserModuleParseError({
              message: `Failed to parse TypeScript/JavaScript: ${error instanceof Error ? error.message : String(error)}`,
              path: resolvedPath,
              cause: error,
            })
          );
        }

        return extractExports(ast);
      }),

    validateImports: (absolutePath, ref) =>
      Effect.gen(function* () {
        const exports = yield* createUserModuleParser().parseExports(absolutePath);

        // Check default import
        if (ref.default && !exports.hasDefault) {
          return yield* Effect.fail(
            new ExportNotFoundError({
              message: `Module does not have a default export`,
              modulePath: absolutePath,
              exportName: "default",
              availableExports: exports.named as string[],
            })
          );
        }

        // Check named imports
        if (ref.named) {
          const missing = pipe(
            ref.named,
            Arr.filter(name => !exports.named.includes(name))
          );

          if (missing.length > 0) {
            return yield* Effect.fail(
              new ExportNotFoundError({
                message: `Export${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}`,
                modulePath: absolutePath,
                exportName: missing[0]!,
                availableExports: exports.named as string[],
              })
            );
          }
        }

        // Namespace imports (import * as X) don't need validation -
        // they always work as long as the file exists
      }),
  };
}

// =============================================================================
// Layer
// =============================================================================

/**
 * Live layer for UserModuleParser service.
 */
export const UserModuleParserLive = Layer.succeed(
  UserModuleParserService,
  createUserModuleParser()
);
