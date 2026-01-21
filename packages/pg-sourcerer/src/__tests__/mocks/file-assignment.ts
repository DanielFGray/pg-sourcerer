/**
 * Mock Factory for FileNamingContext
 *
 * Provides a factory function for creating FileNamingContext objects
 * used in file assignment tests.
 *
 * @module file-assignment
 */
import type { FileNamingContext } from "../../runtime/file-assignment.js";

/**
 * Create a mock FileNamingContext with sensible defaults.
 *
 * @example
 * ```ts
 * const ctx = mockFileNamingContext({ name: "User", entityName: "User" })
 * const ctx = mockFileNamingContext({ 
 *   name: "UserInsert", 
 *   baseEntityName: "User",
 *   variant: "insert"
 * })
 * ```
 */
export function mockFileNamingContext(overrides: Partial<FileNamingContext> = {}): FileNamingContext {
  return {
    name: overrides.name ?? "User",
    entityName: overrides.entityName ?? "User",
    baseEntityName: overrides.baseEntityName ?? "User",
    folderName: overrides.folderName ?? "user",
    variant: overrides.variant,
    schema: overrides.schema ?? "public",
    capability: overrides.capability ?? "type:User",
    ...overrides,
  };
}
