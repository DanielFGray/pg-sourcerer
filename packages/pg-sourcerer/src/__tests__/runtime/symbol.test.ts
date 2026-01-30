/**
 * Tests for symbol factory functions
 */
import { describe, it, expect } from "@effect/vitest";
import { symbol, virtualSymbol } from "../../runtime/symbol.js";
import { conjure } from "../../conjure/index.js";

const b = conjure.b;

describe("symbol()", () => {
  it("should infer 'named' export from ExportNamedDeclaration", () => {
    const result = symbol({
      name: "User",
      capability: "type:User",
      node: b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("User"),
          b.tsInterfaceBody([]),
        ),
      ),
    });

    expect(result.name).toBe("User");
    expect(result.capability).toBe("type:User");
    expect(result.exports).toBe("named");
    expect(result.node).toBeDefined();
    expect(result.node?.type).toBe("ExportNamedDeclaration");
  });

  it("should infer 'default' export from ExportDefaultDeclaration", () => {
    const result = symbol({
      name: "config",
      capability: "config:default",
      node: b.exportDefaultDeclaration(
        b.objectExpression([]),
      ),
    });

    expect(result.name).toBe("config");
    expect(result.capability).toBe("config:default");
    expect(result.exports).toBe("default");
    expect(result.node?.type).toBe("ExportDefaultDeclaration");
  });

  it("should infer false for non-export declarations", () => {
    const result = symbol({
      name: "helper",
      capability: "util:helper",
      node: b.functionDeclaration(
        b.identifier("helper"),
        [],
        b.blockStatement([]),
      ),
    });

    expect(result.name).toBe("helper");
    expect(result.capability).toBe("util:helper");
    expect(result.exports).toBe(false);
  });

  it("should allow explicit override of inferred exports", () => {
    const result = symbol({
      name: "User",
      capability: "type:User",
      node: b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("User"),
          b.tsInterfaceBody([]),
        ),
      ),
      exports: false, // Override inference
    });

    expect(result.exports).toBe(false);
  });

  it("should preserve metadata", () => {
    const metadata = { kind: "select-one", returnType: "User" };
    const result = symbol({
      name: "findUser",
      capability: "query:findUser",
      node: b.functionDeclaration(
        b.identifier("findUser"),
        [],
        b.blockStatement([]),
      ),
      metadata,
    });

    expect(result.metadata).toBe(metadata);
  });

  it("should preserve imports", () => {
    const imports = [{ from: "kysely", types: ["ColumnType"] }];
    const result = symbol({
      name: "User",
      capability: "type:User",
      node: b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("User"),
          b.tsInterfaceBody([]),
        ),
      ),
      imports,
    });

    expect(result.imports).toBe(imports);
  });

  it("should preserve userImports", () => {
    const userImports = [{ modulePath: "./helpers", kind: "default" as const }];
    const result = symbol({
      name: "User",
      capability: "type:User",
      node: b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("User"),
          b.tsInterfaceBody([]),
        ),
      ),
      userImports,
    });

    expect(result.userImports).toBe(userImports);
  });

  it("should preserve deprecated fileHeader", () => {
    const result = symbol({
      name: "User",
      capability: "type:User",
      node: b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("User"),
          b.tsInterfaceBody([]),
        ),
      ),
      fileHeader: "/* eslint-disable */",
    });

    expect(result.fileHeader).toBe("/* eslint-disable */");
  });
});

describe("virtualSymbol()", () => {
  it("should create symbol with null node", () => {
    const result = virtualSymbol({
      name: "findUser",
      capability: "queries:User:findById",
    });

    expect(result.name).toBe("findUser");
    expect(result.capability).toBe("queries:User:findById");
    expect(result.node).toBeNull();
    expect(result.exports).toBe(false);
  });

  it("should preserve metadata", () => {
    const metadata = {
      kind: "select-one",
      params: [{ name: "id", type: "string" }],
      returnType: "User",
    };

    const result = virtualSymbol({
      name: "findUser",
      capability: "queries:User:findById",
      metadata,
    });

    expect(result.metadata).toBe(metadata);
  });

  it("should preserve imports", () => {
    const imports = [{ from: "effect", types: ["Effect"] }];
    const result = virtualSymbol({
      name: "findUser",
      capability: "queries:User:findById",
      imports,
    });

    expect(result.imports).toBe(imports);
  });

  it("should preserve userImports", () => {
    const userImports = [{ modulePath: "./db", kind: "named" as const, imports: ["pool"] }];
    const result = virtualSymbol({
      name: "findUser",
      capability: "queries:User:findById",
      userImports,
    });

    expect(result.userImports).toBe(userImports);
  });
});
