/**
 * User Module Parser Service
 *
 * Parses TypeScript/JavaScript files to extract export information.
 * Used to validate that userModule() references point to valid exports.
 */
import { parse, type ParserPlugin } from "@babel/parser";
import { Context, Effect, Layer, pipe, Array as Arr, Option } from "effect";
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
 * Extract named exports from a declaration node.
 */
function extractNamedFromDeclaration(decl: { type: string; id?: { name: string } | null; declarations?: Array<{ id: { type: string; name?: string } }> }): readonly string[] {
  if (decl.type === "VariableDeclaration" && decl.declarations) {
    return decl.declarations
      .filter(d => d.id.type === "Identifier" && d.id.name)
      .map(d => (d.id as { name: string }).name);
  }
  if (
    (decl.type === "FunctionDeclaration" ||
      decl.type === "ClassDeclaration" ||
      decl.type === "TSTypeAliasDeclaration" ||
      decl.type === "TSInterfaceDeclaration" ||
      decl.type === "TSEnumDeclaration") &&
    decl.id
  ) {
    return [decl.id.name];
  }
  return [];
}

/**
 * Extract export names from parsed AST.
 */
function extractExports(ast: ReturnType<typeof parse>): UserModuleExports {
  return pipe(
    ast.program.body,
    Arr.reduce({ named: [] as string[], hasDefault: false as boolean }, (acc, node) => {
      if (node.type === "ExportDefaultDeclaration") {
        return { ...acc, hasDefault: true };
      }

      if (node.type === "ExportNamedDeclaration") {
        // export const foo = ..., export function bar() {}, export class Baz {}
        const declExports = node.declaration
          ? extractNamedFromDeclaration(node.declaration as Parameters<typeof extractNamedFromDeclaration>[0])
          : [];

        // export { foo, bar } or export { foo, bar } from "./other"
        const specifierExports = (node.specifiers ?? [])
          .filter((spec): spec is typeof spec & { type: "ExportSpecifier" } => spec.type === "ExportSpecifier")
          .map(spec =>
            spec.exported.type === "Identifier" ? spec.exported.name : (spec.exported as { value: string }).value,
          );

        return { ...acc, named: [...acc.named, ...declExports, ...specifierExports] };
      }

      // Note: We explicitly don't follow ExportAllDeclaration (export * from "./other")
      // as per design decision to only check direct exports
      return acc;
    }),
  );
}

/**
 * Create a UserModuleParser implementation.
 */
/**
 * Try to read a file at the given path, returning Option.some with content if found.
 */
function tryReadFile(
  fs: FileSystem.FileSystem,
  tryPath: string,
): Effect.Effect<Option.Option<{ path: string; content: string }>, UserModuleParseError> {
  return pipe(
    fs.exists(tryPath),
    Effect.orElseSucceed(() => false),
    Effect.flatMap(exists =>
      exists
        ? pipe(
            fs.readFileString(tryPath),
            Effect.map(content => Option.some({ path: tryPath, content })),
            Effect.mapError(
              cause =>
                new UserModuleParseError({
                  message: `Failed to read file: ${tryPath}`,
                  path: tryPath,
                  cause,
                }),
            ),
          )
        : Effect.succeed(Option.none()),
    ),
  );
}

export function createUserModuleParser(): UserModuleParser {
  return {
    parseExports: absolutePath =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Try normalized paths (.ts first, then .js)
        const pathsToTry = normalizeFilePath(absolutePath);

        // Find first existing file
        const found = yield* pipe(
          Effect.forEach(pathsToTry, path => tryReadFile(fs, path)),
          Effect.map(Arr.findFirst(Option.isSome)),
          Effect.map(Option.flatten),
        );

        if (Option.isNone(found)) {
          return yield* Effect.fail(
            new UserModuleNotFoundError({
              message: `User module not found: ${absolutePath}`,
              configPath: absolutePath,
              resolvedPath: pathsToTry[0] ?? absolutePath,
            }),
          );
        }

        const { path: resolvedPath, content } = found.value;

        // Parse the file
        const ast = Effect.try({
          try: () =>
            parse(content, {
              sourceType: "module",
              plugins: getParserPlugins(resolvedPath),
              // Be lenient with parsing errors for better UX
              errorRecovery: true,
            }),
          catch: error =>
            new UserModuleParseError({
              message: `Failed to parse TypeScript/JavaScript: ${error instanceof Error ? error.message : String(error)}`,
              path: resolvedPath,
              cause: error,
            }),
        });

        return extractExports(yield* ast);
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
