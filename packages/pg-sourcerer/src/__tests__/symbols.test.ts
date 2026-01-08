/**
 * Symbol Registry Tests
 *
 * Tests for symbol registration, resolution, and import path calculation.
 */
import { describe, it, expect } from "@effect/vitest"
import {
  createSymbolRegistry,
  type Symbol,
  type SymbolRef,
} from "../services/symbols.js"

describe("SymbolRegistry", () => {
  describe("register and resolve", () => {
    it("registers and resolves a symbol", () => {
      const registry = createSymbolRegistry()

      const symbol: Symbol = {
        name: "User",
        file: "types/User.ts",
        capability: "types",
        entity: "User",
        isType: true,
        isDefault: false,
      }

      registry.register(symbol, "types-plugin")

      const ref: SymbolRef = {
        capability: "types",
        entity: "User",
      }

      const resolved = registry.resolve(ref)
      expect(resolved).toEqual(symbol)
    })

    it("resolves symbol with shape", () => {
      const registry = createSymbolRegistry()

      const rowSymbol: Symbol = {
        name: "User",
        file: "types/User.ts",
        capability: "types",
        entity: "User",
        shape: "row",
        isType: true,
        isDefault: false,
      }

      const insertSymbol: Symbol = {
        name: "UserInsert",
        file: "types/User.ts",
        capability: "types",
        entity: "User",
        shape: "insert",
        isType: true,
        isDefault: false,
      }

      registry.register(rowSymbol, "types-plugin")
      registry.register(insertSymbol, "types-plugin")

      const rowRef: SymbolRef = { capability: "types", entity: "User", shape: "row" }
      const insertRef: SymbolRef = { capability: "types", entity: "User", shape: "insert" }

      expect(registry.resolve(rowRef)).toEqual(rowSymbol)
      expect(registry.resolve(insertRef)).toEqual(insertSymbol)
    })

    it("returns undefined for unregistered symbol", () => {
      const registry = createSymbolRegistry()

      const ref: SymbolRef = {
        capability: "types",
        entity: "NonExistent",
      }

      expect(registry.resolve(ref)).toBeUndefined()
    })

    it("distinguishes symbols by capability", () => {
      const registry = createSymbolRegistry()

      const typeSymbol: Symbol = {
        name: "User",
        file: "types/User.ts",
        capability: "types",
        entity: "User",
        isType: true,
        isDefault: false,
      }

      const schemaSymbol: Symbol = {
        name: "UserSchema",
        file: "schemas/User.ts",
        capability: "schemas",
        entity: "User",
        isType: false,
        isDefault: false,
      }

      registry.register(typeSymbol, "types-plugin")
      registry.register(schemaSymbol, "schemas-plugin")

      expect(registry.resolve({ capability: "types", entity: "User" })).toEqual(typeSymbol)
      expect(registry.resolve({ capability: "schemas", entity: "User" })).toEqual(schemaSymbol)
    })
  })

  describe("getAll", () => {
    it("returns all registered symbols", () => {
      const registry = createSymbolRegistry()

      const symbols: Symbol[] = [
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        { name: "Post", file: "types/Post.ts", capability: "types", entity: "Post", isType: true, isDefault: false },
        { name: "UserSchema", file: "schemas/User.ts", capability: "schemas", entity: "User", isType: false, isDefault: false },
      ]

      for (const symbol of symbols) {
        registry.register(symbol, "test-plugin")
      }

      const all = registry.getAll()
      expect(all).toHaveLength(3)
      expect(all).toContainEqual(symbols[0])
      expect(all).toContainEqual(symbols[1])
      expect(all).toContainEqual(symbols[2])
    })

    it("returns empty array when no symbols registered", () => {
      const registry = createSymbolRegistry()
      expect(registry.getAll()).toEqual([])
    })
  })

  describe("validate", () => {
    it("returns no collisions for unique symbols", () => {
      const registry = createSymbolRegistry()

      registry.register(
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        "types-plugin"
      )
      registry.register(
        { name: "Post", file: "types/Post.ts", capability: "types", entity: "Post", isType: true, isDefault: false },
        "types-plugin"
      )

      expect(registry.validate()).toEqual([])
    })

    it("detects collision when same name and kind in same file from different plugins", () => {
      const registry = createSymbolRegistry()

      // Both are types - this is a collision
      registry.register(
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        "plugin-a"
      )
      registry.register(
        { name: "User", file: "types/User.ts", capability: "schemas", entity: "User", isType: true, isDefault: false },
        "plugin-b"
      )

      const collisions = registry.validate()
      expect(collisions).toHaveLength(1)
      expect(collisions[0]?.symbol).toBe("User")
      expect(collisions[0]?.file).toBe("types/User.ts")
      expect(collisions[0]?.plugins).toContain("plugin-a")
      expect(collisions[0]?.plugins).toContain("plugin-b")
    })

    it("no collision when type and value have same name in same file from different plugins", () => {
      const registry = createSymbolRegistry()

      // One is a type, one is a value - allowed (different namespaces in TS)
      registry.register(
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        "plugin-a"
      )
      registry.register(
        { name: "User", file: "types/User.ts", capability: "schemas", entity: "User", isType: false, isDefault: false },
        "plugin-b"
      )

      expect(registry.validate()).toEqual([])
    })

    it("no collision when same plugin registers same name multiple times", () => {
      const registry = createSymbolRegistry()

      // Same plugin registering same symbol is OK (might be intentional)
      registry.register(
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        "types-plugin"
      )
      registry.register(
        { name: "User", file: "types/User.ts", capability: "types", entity: "User", shape: "row", isType: true, isDefault: false },
        "types-plugin"
      )

      expect(registry.validate()).toEqual([])
    })

    it("no collision when same name in different files", () => {
      const registry = createSymbolRegistry()

      registry.register(
        { name: "Index", file: "types/index.ts", capability: "types", entity: "User", isType: true, isDefault: false },
        "plugin-a"
      )
      registry.register(
        { name: "Index", file: "schemas/index.ts", capability: "schemas", entity: "User", isType: false, isDefault: false },
        "plugin-b"
      )

      expect(registry.validate()).toEqual([])
    })
  })

  describe("importFor", () => {
    describe("relative path calculation", () => {
      it("same directory uses ./", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "Post",
          file: "types/Post.ts",
          capability: "types",
          entity: "Post",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "types/User.ts")
        expect(importStmt.from).toBe("./Post.js")
      })

      it("sibling directory uses ../", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "schemas/User.ts")
        expect(importStmt.from).toBe("../types/User.js")
      })

      it("nested directory uses multiple ../", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "schemas/deep/nested/Schema.ts")
        expect(importStmt.from).toBe("../../../types/User.js")
      })

      it("child directory uses ./subdir/", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "Base",
          file: "types/base/Base.ts",
          capability: "types",
          entity: "Base",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "types/User.ts")
        expect(importStmt.from).toBe("./base/Base.js")
      })

      it("root to nested directory", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "Deep",
          file: "a/b/c/Deep.ts",
          capability: "types",
          entity: "Deep",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "Root.ts")
        expect(importStmt.from).toBe("./a/b/c/Deep.js")
      })

      it("nested to root directory", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "Root",
          file: "Root.ts",
          capability: "types",
          entity: "Root",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "a/b/c/Deep.ts")
        expect(importStmt.from).toBe("../../../Root.js")
      })

      it("converts .ts extension to .js", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "types/Other.ts")
        expect(importStmt.from.endsWith(".js")).toBe(true)
        expect(importStmt.from).not.toContain(".ts")
      })

      it("handles files without .ts extension", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "schemas/Schema.ts")
        // Should handle gracefully (no double extension)
        expect(importStmt.from).toBe("../types/User")
      })

      it("handles common parent directory", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "shared/types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "shared/schemas/UserSchema.ts")
        expect(importStmt.from).toBe("../types/User.js")
      })
    })

    describe("import types", () => {
      it("type import goes to types array", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User.ts",
          capability: "types",
          entity: "User",
          isType: true,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "schemas/User.ts")
        expect(importStmt.types).toEqual(["User"])
        expect(importStmt.named).toEqual([])
        expect(importStmt.default).toBeUndefined()
      })

      it("value import goes to named array", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "UserSchema",
          file: "schemas/User.ts",
          capability: "schemas",
          entity: "User",
          isType: false,
          isDefault: false,
        }

        const importStmt = registry.importFor(symbol, "routes/users.ts")
        expect(importStmt.named).toEqual(["UserSchema"])
        expect(importStmt.types).toEqual([])
        expect(importStmt.default).toBeUndefined()
      })

      it("default import uses default property", () => {
        const registry = createSymbolRegistry()

        const symbol: Symbol = {
          name: "User",
          file: "types/User.ts",
          capability: "types",
          entity: "User",
          isType: false,
          isDefault: true,
        }

        const importStmt = registry.importFor(symbol, "schemas/User.ts")
        expect(importStmt.default).toBe("User")
        expect(importStmt.named).toEqual([])
        expect(importStmt.types).toEqual([])
      })
    })
  })
})
