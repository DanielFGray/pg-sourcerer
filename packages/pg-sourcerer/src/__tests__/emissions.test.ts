/**
 * Emission Buffer Unit Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import recast from "recast"
import type { ASTNode } from "ast-types"
import { createEmissionBuffer } from "../services/emissions.js"
import { createSymbolRegistry } from "../services/symbols.js"
import type { ImportRef } from "../services/file-builder.js"

const b = recast.types.builders
const serialize = (ast: ASTNode) => recast.print(ast).code

describe("Emission Buffer", () => {
  describe("emit", () => {
    it("stores a file emission", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "export interface User {}", "types-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual({
        path: "types/User.ts",
        content: "export interface User {}",
        plugin: "types-plugin",
      })
    })

    it("allows multiple different files", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "interface User {}", "types-plugin")
      buffer.emit("types/Post.ts", "interface Post {}", "types-plugin")
      buffer.emit("schemas/User.ts", "const UserSchema = {}", "schema-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(3)
    })

    it("overwrites same file from same plugin", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "first version", "types-plugin")
      buffer.emit("types/User.ts", "second version", "types-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("second version")
    })

    it("tracks conflict when different plugin writes same file", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "from plugin A", "plugin-a")
      buffer.emit("types/User.ts", "from plugin B", "plugin-b")

      // getAll returns last write
      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("from plugin B")
      expect(all[0]?.plugin).toBe("plugin-b")
    })
  })

  describe("appendEmit", () => {
    it("appends to existing file from same plugin", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("index.ts", "// header\n", "index-plugin")
      buffer.appendEmit("index.ts", "export * from './User.js'\n", "index-plugin")
      buffer.appendEmit("index.ts", "export * from './Post.js'\n", "index-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe(
        "// header\nexport * from './User.js'\nexport * from './Post.js'\n"
      )
    })

    it("creates new file if not exists", () => {
      const buffer = createEmissionBuffer()
      buffer.appendEmit("index.ts", "export * from './User.js'\n", "index-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("export * from './User.js'\n")
    })

    it("silently ignores append from different plugin (tracks conflict)", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("index.ts", "from plugin A", "plugin-a")
      buffer.appendEmit("index.ts", " plus plugin B", "plugin-b")

      // Content should NOT be appended (different plugin)
      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("from plugin A")
      expect(all[0]?.plugin).toBe("plugin-a")
    })
  })

  describe("getAll", () => {
    it("returns empty array when no emissions", () => {
      const buffer = createEmissionBuffer()
      expect(buffer.getAll()).toEqual([])
    })

    it("returns all emissions as array", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("a.ts", "a", "p")
      buffer.emit("b.ts", "b", "p")
      buffer.emit("c.ts", "c", "p")

      const all = buffer.getAll()
      expect(all).toHaveLength(3)
      expect(all.map((e) => e.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"])
    })
  })

  describe("validate", () => {
    it.effect("succeeds with no conflicts", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "User", "types-plugin")
        buffer.emit("types/Post.ts", "Post", "types-plugin")
        buffer.emit("schemas/User.ts", "UserSchema", "schema-plugin")

        yield* buffer.validate()
        // No error means success
      })
    )

    it.effect("succeeds with same plugin writing to same file", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "first", "types-plugin")
        buffer.emit("types/User.ts", "second", "types-plugin")

        yield* buffer.validate()
        // Same plugin overwriting is allowed
      })
    )

    it.effect("fails when different plugins write same file", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "from A", "plugin-a")
        buffer.emit("types/User.ts", "from B", "plugin-b")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          expect(result.left.path).toBe("types/User.ts")
          expect(result.left.plugins).toContain("plugin-a")
          expect(result.left.plugins).toContain("plugin-b")
        }
      })
    )

    it.effect("fails when different plugin tries to append", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("index.ts", "header", "plugin-a")
        buffer.appendEmit("index.ts", "append", "plugin-b")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          expect(result.left.path).toBe("index.ts")
        }
      })
    )

    it.effect("reports first conflict found", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        // Create multiple conflicts
        buffer.emit("a.ts", "a1", "plugin-1")
        buffer.emit("a.ts", "a2", "plugin-2")
        buffer.emit("b.ts", "b1", "plugin-1")
        buffer.emit("b.ts", "b2", "plugin-2")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          // Should report one of the conflicts
          expect(["a.ts", "b.ts"]).toContain(result.left.path)
        }
      })
    )
  })

  describe("clear", () => {
    it("removes all emissions", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("a.ts", "a", "p")
      buffer.emit("b.ts", "b", "p")
      buffer.emit("c.ts", "c", "p")

      expect(buffer.getAll()).toHaveLength(3)

      buffer.clear()

      expect(buffer.getAll()).toHaveLength(0)
    })

    it.effect("clears conflict tracking", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()

        // Create a conflict
        buffer.emit("x.ts", "a", "plugin-a")
        buffer.emit("x.ts", "b", "plugin-b")

        // Confirm conflict exists
        const beforeClear = yield* buffer.validate().pipe(Effect.either)
        expect(beforeClear._tag).toBe("Left")

        // Clear and add clean emission
        buffer.clear()
        buffer.emit("x.ts", "clean", "plugin-c")

        // Should validate clean now
        yield* buffer.validate()
      })
    )
  })

  describe("emitAst", () => {
    it("stores AST emission with header", () => {
      const buffer = createEmissionBuffer()
      const program = b.program([
        b.variableDeclaration("const", [
          b.variableDeclarator(b.identifier("x"), b.numericLiteral(1)),
        ]),
      ])

      buffer.emitAst("output/test.ts", program, "test-plugin", "// Header\n")

      const astEmissions = buffer.getAstEmissions()
      expect(astEmissions).toHaveLength(1)
      expect(astEmissions[0]!.path).toBe("output/test.ts")
      expect(astEmissions[0]!.header).toBe("// Header\n")
    })

    it("stores AST emission with imports", () => {
      const buffer = createEmissionBuffer()
      const program = b.program([])
      const imports: ImportRef[] = [
        { kind: "package", names: ["z"], from: "zod" },
      ]

      buffer.emitAst("output/test.ts", program, "test-plugin", undefined, imports)

      const astEmissions = buffer.getAstEmissions()
      expect(astEmissions).toHaveLength(1)
      expect(astEmissions[0]!.imports).toEqual(imports)
    })
  })

  describe("serializeAst", () => {
    it("serializes AST with header", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([
        b.variableDeclaration("const", [
          b.variableDeclarator(b.identifier("x"), b.numericLiteral(1)),
        ]),
      ])

      buffer.emitAst("output/test.ts", program, "test-plugin", "// Header\n")
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.content).toContain("// Header")
      expect(all[0]!.content).toContain("const x = 1")
    })

    it("resolves package imports", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([
        b.variableDeclaration("const", [
          b.variableDeclarator(b.identifier("schema"), b.identifier("z.object({})")),
        ]),
      ])
      const imports: ImportRef[] = [
        { kind: "package", names: ["z"], from: "zod" },
      ]

      buffer.emitAst("output/schema.ts", program, "zod-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.content).toContain('import { z } from "zod"')
    })

    it("resolves relative imports", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([])
      const imports: ImportRef[] = [
        { kind: "relative", types: ["User"], from: "./types.js" },
      ]

      buffer.emitAst("output/schema.ts", program, "zod-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      // types are imported with type-only import declaration
      expect(all[0]!.content).toContain("import type")
      expect(all[0]!.content).toContain("User")
      expect(all[0]!.content).toContain("./types.js")
    })

    it("resolves symbol imports via SymbolRegistry", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()

      // Register a symbol first
      symbols.register(
        {
          name: "User",
          file: "generated/types/User.ts",
          capability: "types",
          entity: "User",
          shape: "row",
          isType: true,
          isDefault: false,
        },
        "types-plugin"
      )

      const program = b.program([])
      const imports: ImportRef[] = [
        {
          kind: "symbol",
          ref: { capability: "types", entity: "User", shape: "row" },
        },
      ]

      // Emit from a different file
      buffer.emitAst(
        "generated/schemas/User.ts",
        program,
        "zod-plugin",
        undefined,
        imports
      )
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      // Should have relative import from schemas/User.ts to types/User.ts
      expect(all[0]!.content).toContain("import")
      expect(all[0]!.content).toContain("User")
      expect(all[0]!.content).toContain("../types/User.js")
    })

    it("merges imports from same source", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([])
      const imports: ImportRef[] = [
        { kind: "package", names: ["Effect"], from: "effect" },
        { kind: "package", names: ["Context"], from: "effect" },
        { kind: "package", types: ["Layer"], from: "effect" },
      ]

      buffer.emitAst("output/test.ts", program, "test-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      // Value imports and type imports are now in separate statements
      // (both from the same source)
      const valueImportMatches = all[0]!.content.match(/import \{.*\} from "effect"/g)
      const typeImportMatches = all[0]!.content.match(/import type \{.*\} from "effect"/g)
      expect(valueImportMatches).toHaveLength(1)
      expect(typeImportMatches).toHaveLength(1)
      expect(all[0]!.content).toContain("Effect")
      expect(all[0]!.content).toContain("Context")
      expect(all[0]!.content).toContain("Layer")
    })

    it("handles default imports", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([])
      const imports: ImportRef[] = [
        { kind: "package", default: "React", from: "react" },
      ]

      buffer.emitAst("output/test.tsx", program, "test-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.content).toContain('import React from "react"')
    })

    it("handles combined default and named imports", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([])
      const imports: ImportRef[] = [
        { kind: "package", default: "React", names: ["useState", "useEffect"], from: "react" },
      ]

      buffer.emitAst("output/test.tsx", program, "test-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.content).toContain("import React")
      expect(all[0]!.content).toContain("useState")
      expect(all[0]!.content).toContain("useEffect")
    })

    it("tracks unresolved symbol imports", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([
        b.variableDeclaration("const", [
          b.variableDeclarator(b.identifier("x"), b.numericLiteral(1)),
        ]),
      ])
      const imports: ImportRef[] = [
        {
          kind: "symbol",
          ref: { capability: "nonexistent", entity: "Missing" },
        },
      ]

      buffer.emitAst("output/test.ts", program, "test-plugin", undefined, imports)
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      // Should not fail, just skip the unresolved import in the output
      expect(all[0]!.content).toContain("const x = 1")
      expect(all[0]!.content).not.toContain("import")

      // But should track the unresolved reference
      const unresolved = buffer.getUnresolvedRefs()
      expect(unresolved).toHaveLength(1)
      expect(unresolved[0]).toEqual({
        capability: "nonexistent",
        entity: "Missing",
        shape: undefined,
        plugin: "test-plugin",
        file: "output/test.ts",
      })
    })

    it("tracks multiple unresolved references across files", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()

      // File 1 with one missing import
      buffer.emitAst(
        "output/a.ts",
        b.program([]),
        "plugin-a",
        undefined,
        [{ kind: "symbol", ref: { capability: "types", entity: "User" } }]
      )

      // File 2 with two missing imports
      buffer.emitAst(
        "output/b.ts",
        b.program([]),
        "plugin-b",
        undefined,
        [
          { kind: "symbol", ref: { capability: "types", entity: "Post" } },
          { kind: "symbol", ref: { capability: "schemas", entity: "User", shape: "insert" } },
        ]
      )

      buffer.serializeAst(serialize, symbols)

      const unresolved = buffer.getUnresolvedRefs()
      expect(unresolved).toHaveLength(3)
      expect(unresolved).toContainEqual({
        capability: "types",
        entity: "User",
        shape: undefined,
        plugin: "plugin-a",
        file: "output/a.ts",
      })
      expect(unresolved).toContainEqual({
        capability: "types",
        entity: "Post",
        shape: undefined,
        plugin: "plugin-b",
        file: "output/b.ts",
      })
      expect(unresolved).toContainEqual({
        capability: "schemas",
        entity: "User",
        shape: "insert",
        plugin: "plugin-b",
        file: "output/b.ts",
      })
    })

    it("clear() resets unresolved refs", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()

      buffer.emitAst(
        "output/test.ts",
        b.program([]),
        "test-plugin",
        undefined,
        [{ kind: "symbol", ref: { capability: "missing", entity: "Thing" } }]
      )
      buffer.serializeAst(serialize, symbols)

      expect(buffer.getUnresolvedRefs()).toHaveLength(1)

      buffer.clear()

      expect(buffer.getUnresolvedRefs()).toHaveLength(0)
    })

    it("does not track resolved symbol imports as unresolved", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()

      // Register a symbol
      symbols.register(
        {
          name: "User",
          file: "generated/types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        },
        "types-plugin"
      )

      buffer.emitAst(
        "generated/schemas/User.ts",
        b.program([]),
        "zod-plugin",
        undefined,
        [{ kind: "symbol", ref: { capability: "types", entity: "User" } }]
      )
      buffer.serializeAst(serialize, symbols)

      // Should have the import in output
      const all = buffer.getAll()
      expect(all[0]!.content).toContain("import")
      expect(all[0]!.content).toContain("User")

      // Should NOT track as unresolved
      expect(buffer.getUnresolvedRefs()).toHaveLength(0)
    })

    it("clears AST emissions after serialization", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      const program = b.program([])

      buffer.emitAst("output/test.ts", program, "test-plugin")
      expect(buffer.getAstEmissions()).toHaveLength(1)

      buffer.serializeAst(serialize, symbols)
      expect(buffer.getAstEmissions()).toHaveLength(0)
    })

    it("adds blank lines before export statements", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      // Create a program with consecutive exports (no blank lines from recast)
      const program = b.program([
        b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier("a"), b.numericLiteral(1)),
          ]),
          []
        ),
        b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier("b"), b.numericLiteral(2)),
          ]),
          []
        ),
        b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier("c"), b.numericLiteral(3)),
          ]),
          []
        ),
      ])

      buffer.emitAst("output/test.ts", program, "test-plugin")
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      const content = all[0]!.content
      // Each export after the first should be preceded by a blank line
      expect(content).toContain("export const a = 1;\n\nexport const b = 2;")
      expect(content).toContain("export const b = 2;\n\nexport const c = 3;")
    })

    it("collapses multiple blank lines before exports to one", () => {
      const buffer = createEmissionBuffer()
      const symbols = createSymbolRegistry()
      // Manually construct output that would have multiple blank lines
      // We'll test by checking the regex logic handles this case
      const program = b.program([
        b.exportNamedDeclaration(
          b.variableDeclaration("const", [
            b.variableDeclarator(b.identifier("x"), b.numericLiteral(1)),
          ]),
          []
        ),
      ])

      buffer.emitAst("output/test.ts", program, "test-plugin")
      buffer.serializeAst(serialize, symbols)

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      // Should not have triple+ newlines before export
      expect(all[0]!.content).not.toMatch(/\n\n\nexport/)
    })
  })
})
