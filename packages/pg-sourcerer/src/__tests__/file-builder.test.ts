/**
 * FileBuilder tests
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
  createFileBuilder,
  createFileBuilderFactory,
  type ImportRef,
} from "../services/file-builder.js"
import { createEmissionBuffer } from "../services/emissions.js"
import { createSymbolRegistry } from "../services/symbols.js"
import { conjure } from "../lib/conjure.js"

describe("FileBuilder", () => {
  let emissions: ReturnType<typeof createEmissionBuffer>
  let symbols: ReturnType<typeof createSymbolRegistry>

  beforeEach(() => {
    emissions = createEmissionBuffer()
    symbols = createSymbolRegistry()
  })

  describe("basic usage", () => {
    it("emits raw content", () => {
      const builder = createFileBuilder(
        "output/test.ts",
        "test-plugin",
        emissions,
        symbols
      )

      builder.content("const x = 1;").emit()

      const all = emissions.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.path).toBe("output/test.ts")
      expect(all[0]!.content).toBe("const x = 1;")
      expect(all[0]!.plugin).toBe("test-plugin")
    })

    it("emits content with header", () => {
      const builder = createFileBuilder(
        "output/test.ts",
        "test-plugin",
        emissions,
        symbols
      )

      builder
        .header("// Auto-generated - do not edit")
        .content("const x = 1;")
        .emit()

      const all = emissions.getAll()
      expect(all[0]!.content).toBe(
        "// Auto-generated - do not edit\nconst x = 1;"
      )
    })

    it("concatenates multiple headers", () => {
      const builder = createFileBuilder(
        "output/test.ts",
        "test-plugin",
        emissions,
        symbols
      )

      builder
        .header("// Line 1")
        .header("// Line 2")
        .content("const x = 1;")
        .emit()

      const all = emissions.getAll()
      expect(all[0]!.content).toBe("// Line 1\n// Line 2\nconst x = 1;")
    })
  })

  describe("AST mode", () => {
    it("emits AST program", () => {
      const builder = createFileBuilder(
        "output/types.ts",
        "types-plugin",
        emissions,
        symbols
      )

      const program = conjure.program(
        conjure.stmt.const("x", conjure.num(1)),
        conjure.stmt.const("y", conjure.num(2))
      )

      builder.ast(program).emit()

      const astEmissions = emissions.getAstEmissions()
      expect(astEmissions).toHaveLength(1)
      expect(astEmissions[0]!.path).toBe("output/types.ts")
    })

    it("extracts symbols from SymbolProgram", () => {
      const builder = createFileBuilder(
        "output/types.ts",
        "types-plugin",
        emissions,
        symbols
      )

      const program = conjure.symbolProgram(
        conjure.exp.interface(
          "User",
          { capability: "types", entity: "User", shape: "row" },
          [{ name: "id", type: conjure.ts.string() }]
        ),
        conjure.exp.typeAlias(
          "Role",
          { capability: "types", entity: "Role" },
          conjure.ts.literal("admin")
        )
      )

      builder.ast(program).emit()

      const allSymbols = symbols.getAll()
      expect(allSymbols).toHaveLength(2)

      const userSymbol = allSymbols.find((s) => s.name === "User")
      expect(userSymbol).toBeDefined()
      expect(userSymbol!.file).toBe("output/types.ts")
      expect(userSymbol!.capability).toBe("types")
      expect(userSymbol!.entity).toBe("User")
      expect(userSymbol!.shape).toBe("row")
      expect(userSymbol!.isType).toBe(true)

      const roleSymbol = allSymbols.find((s) => s.name === "Role")
      expect(roleSymbol).toBeDefined()
      expect(roleSymbol!.entity).toBe("Role")
      expect(roleSymbol!.shape).toBeUndefined()
    })

    it("concatenates multiple ast() calls", () => {
      const builder = createFileBuilder(
        "output/types.ts",
        "types-plugin",
        emissions,
        symbols
      )

      builder
        .ast(conjure.program(conjure.stmt.const("x", conjure.num(1))))
        .ast(conjure.program(conjure.stmt.const("y", conjure.num(2))))
        .emit()

      const astEmissions = emissions.getAstEmissions()
      expect(astEmissions).toHaveLength(1)
      // The program should have both statements
      expect(astEmissions[0]!.ast.body).toHaveLength(2)
    })

    it("combines SymbolProgram and regular Program", () => {
      const builder = createFileBuilder(
        "output/types.ts",
        "types-plugin",
        emissions,
        symbols
      )

      builder
        .ast(
          conjure.symbolProgram(
            conjure.exp.interface(
              "User",
              { capability: "types", entity: "User" },
              []
            )
          )
        )
        .ast(conjure.program(conjure.stmt.const("helper", conjure.num(42))))
        .emit()

      // Should have one symbol from SymbolProgram
      expect(symbols.getAll()).toHaveLength(1)

      // Should have both statements in AST
      const astEmissions = emissions.getAstEmissions()
      expect(astEmissions[0]!.ast.body).toHaveLength(2)
    })
  })

  describe("import tracking", () => {
    it("tracks package imports", () => {
      const builder = createFileBuilder(
        "output/schemas.ts",
        "zod-plugin",
        emissions,
        symbols
      )

      const zodImport: ImportRef = {
        kind: "package",
        names: ["z"],
        from: "zod",
      }

      builder
        .import(zodImport)
        .ast(conjure.program(conjure.stmt.const("x", conjure.num(1))))
        .emit()

      // Import is stored - resolution happens later
      // For now just verify no errors
      expect(emissions.getAstEmissions()).toHaveLength(1)
    })

    it("tracks symbol imports", () => {
      const builder = createFileBuilder(
        "output/schemas.ts",
        "zod-plugin",
        emissions,
        symbols
      )

      const typeImport: ImportRef = {
        kind: "symbol",
        ref: { capability: "types", entity: "User", shape: "row" },
      }

      builder
        .import(typeImport)
        .ast(conjure.program(conjure.stmt.const("x", conjure.num(1))))
        .emit()

      expect(emissions.getAstEmissions()).toHaveLength(1)
    })
  })

  describe("error handling", () => {
    it("throws when mixing content() and ast()", () => {
      const builder = createFileBuilder(
        "output/test.ts",
        "test-plugin",
        emissions,
        symbols
      )

      builder.content("const x = 1;")

      expect(() => builder.ast(conjure.program())).toThrow(
        "Cannot mix ast() and content()"
      )
    })

    it("throws when mixing ast() and content()", () => {
      const builder = createFileBuilder(
        "output/test.ts",
        "test-plugin",
        emissions,
        symbols
      )

      // Need to add actual statements to trigger the check
      builder.ast(conjure.program(conjure.stmt.const("x", conjure.num(1))))

      expect(() => builder.content("const x = 1;")).toThrow(
        "Cannot mix content() and ast()"
      )
    })
  })

  describe("factory", () => {
    it("creates builders with shared context", () => {
      const factory = createFileBuilderFactory(
        "multi-plugin",
        emissions,
        symbols
      )

      factory("output/file1.ts")
        .ast(
          conjure.symbolProgram(
            conjure.exp.interface(
              "Type1",
              { capability: "types", entity: "Entity1" },
              []
            )
          )
        )
        .emit()

      factory("output/file2.ts")
        .ast(
          conjure.symbolProgram(
            conjure.exp.interface(
              "Type2",
              { capability: "types", entity: "Entity2" },
              []
            )
          )
        )
        .emit()

      // Both files emitted
      expect(emissions.getAstEmissions()).toHaveLength(2)

      // Both symbols registered
      expect(symbols.getAll()).toHaveLength(2)
      expect(symbols.getAll().map((s) => s.file)).toContain("output/file1.ts")
      expect(symbols.getAll().map((s) => s.file)).toContain("output/file2.ts")
    })
  })
})
