/**
 * File Assignment Unit Tests
 */
import { describe, it, expect } from "@effect/vitest";
import {
  parseCapabilityInfo,
  getFileForCapability,
  assignSymbolsToFiles,
  groupByFile,
  normalizeFileNaming,
  normalizeFileRule,
  mergeFileRules,
  type FileAssignmentConfig,
  type FileRule,
} from "../runtime/file-assignment.js";
import { createInflection } from "../services/inflection.js";
import type { SymbolDeclaration } from "../runtime/types.js";
import { mockFileNamingContext } from "./mocks/file-assignment.js";

describe("parseCapabilityInfo", () => {
  it("parses simple type capability", () => {
    const info = parseCapabilityInfo("type:User");
    expect(info.entityName).toBe("User");
    expect(info.schema).toBe("public");
  });

  it("parses capability with schema", () => {
    const info = parseCapabilityInfo("type:custom_schema.User");
    expect(info.entityName).toBe("User");
    expect(info.schema).toBe("custom_schema");
  });

  it("parses query capability", () => {
    const info = parseCapabilityInfo("queries:kysely:User:findById");
    expect(info.entityName).toBe("User");
    expect(info.schema).toBe("public");
  });

  it("parses schema:zod capability", () => {
    const info = parseCapabilityInfo("schema:zod:Comment");
    expect(info.entityName).toBe("Comment");
    expect(info.schema).toBe("public");
  });

  it("skips known prefixes", () => {
    const info = parseCapabilityInfo("http-routes:elysia:Post");
    expect(info.entityName).toBe("Post");
  });
});

describe("normalizeFileNaming", () => {
  it("returns default when option is undefined", () => {
    const fn = normalizeFileNaming(undefined, "default.ts");
    expect(fn(mockFileNamingContext())).toBe("default.ts");
  });

  it("wraps string in function", () => {
    const fn = normalizeFileNaming("custom.ts", "default.ts");
    expect(fn(mockFileNamingContext())).toBe("custom.ts");
  });

  it("returns function as-is", () => {
    const customFn = ({ name }: { name: string }) => `${name}.ts`;
    const fn = normalizeFileNaming(customFn, "default.ts");
    expect(fn(mockFileNamingContext({ name: "User" }))).toBe("User.ts");
  });
});

describe("getFileForCapability with registry", () => {
  const createConfig = (rules: FileRule[] = []): FileAssignmentConfig => {
    const inflection = createInflection();
    
    // Pre-populate registry with shape registrations
    inflection.shapeName("User", "row");
    inflection.shapeName("User", "insert");
    inflection.shapeName("User", "update");
    inflection.shapeName("Comment", "row");
    inflection.shapeName("Comment", "insert");
    
    return {
      outputDir: "src/generated",
      rules,
      defaultFile: "index.ts",
      inflection,
    };
  };

  it("uses registry to find baseEntityName for shapes", () => {
    const config = createConfig([
      {
        pattern: "schema:zod:",
        fileNaming: ({ folderName }) => `${folderName}/schemas.ts`,
      },
    ]);

    // UserInsert should map to User via registry
    const declaration: SymbolDeclaration = {
      name: "UserInsert",
      capability: "schema:zod:UserInsert",
    };

    const result = getFileForCapability(declaration, config);
    expect(result).toBe("user/schemas.ts");
  });

  it("uses registry for all shape variants", () => {
    const config = createConfig([
      {
        pattern: "schema:zod:",
        fileNaming: ({ folderName, variant }) => 
          `${folderName}/schemas.ts`,
      },
    ]);

    // All User shapes should go to user/schemas.ts
    const userRow: SymbolDeclaration = {
      name: "User",
      capability: "schema:zod:User",
    };
    const userInsert: SymbolDeclaration = {
      name: "UserInsert",
      capability: "schema:zod:UserInsert",
    };
    const userUpdate: SymbolDeclaration = {
      name: "UserUpdate",
      capability: "schema:zod:UserUpdate",
    };

    expect(getFileForCapability(userRow, config)).toBe("user/schemas.ts");
    expect(getFileForCapability(userInsert, config)).toBe("user/schemas.ts");
    expect(getFileForCapability(userUpdate, config)).toBe("user/schemas.ts");
  });

  it("provides variant in context", () => {
    const config = createConfig([
      {
        pattern: "schema:zod:",
        fileNaming: ({ folderName, variant }) => 
          variant ? `${folderName}/${variant}.ts` : `${folderName}/row.ts`,
      },
    ]);

    const userInsert: SymbolDeclaration = {
      name: "UserInsert",
      capability: "schema:zod:UserInsert",
    };

    const result = getFileForCapability(userInsert, config);
    expect(result).toBe("user/insert.ts");
  });

  it("falls back to capability parsing when not in registry", () => {
    const config = createConfig([
      {
        pattern: "schema:zod:",
        fileNaming: ({ folderName }) => `${folderName}/schemas.ts`,
      },
    ]);

    // Unknown is not registered, should fall back to parsing
    const unknown: SymbolDeclaration = {
      name: "Unknown",
      capability: "schema:zod:Unknown",
    };

    const result = getFileForCapability(unknown, config);
    expect(result).toBe("unknown/schemas.ts");
  });

  it("respects explicit outputPath", () => {
    const config = createConfig([
      {
        pattern: "schema:zod:",
        fileNaming: () => "default.ts",
      },
    ]);

    const declaration: SymbolDeclaration = {
      name: "Custom",
      capability: "schema:zod:Custom",
      outputPath: "custom/path.ts",
    };

    const result = getFileForCapability(declaration, config);
    expect(result).toBe("custom/path.ts");
  });

  it("respects explicit baseEntityName in declaration", () => {
    const inflection = createInflection();
    // Don't register anything in registry
    
    const config: FileAssignmentConfig = {
      outputDir: "src/generated",
      rules: [
        {
          pattern: "schema:zod:",
          fileNaming: ({ folderName }) => `${folderName}/schemas.ts`,
        },
      ],
      defaultFile: "index.ts",
      inflection,
    };

    const declaration: SymbolDeclaration = {
      name: "SomeShape",
      capability: "schema:zod:SomeShape",
      baseEntityName: "BaseEntity", // Explicit override
    };

    const result = getFileForCapability(declaration, config);
    expect(result).toBe("baseEntity/schemas.ts");
  });
});

describe("assignSymbolsToFiles", () => {
  it("assigns all declarations to files", () => {
    const inflection = createInflection();
    inflection.shapeName("User", "row");
    
    const config: FileAssignmentConfig = {
      outputDir: "src/generated",
      rules: [
        { pattern: "type:", fileNaming: () => "types.ts" },
      ],
      defaultFile: "index.ts",
      inflection,
    };

    const declarations: SymbolDeclaration[] = [
      { name: "User", capability: "type:User" },
      { name: "Comment", capability: "type:Comment" },
    ];

    const assigned = assignSymbolsToFiles(declarations, config);
    expect(assigned).toHaveLength(2);
    expect(assigned[0]!.filePath).toBe("types.ts");
    expect(assigned[1]!.filePath).toBe("types.ts");
  });
});

describe("groupByFile", () => {
  it("groups symbols by file path", () => {
    const assigned = [
      { declaration: { name: "User", capability: "type:User" }, filePath: "types.ts" },
      { declaration: { name: "Comment", capability: "type:Comment" }, filePath: "types.ts" },
      { declaration: { name: "UserSchema", capability: "schema:User" }, filePath: "schemas.ts" },
    ];

    const groups = groupByFile(assigned);
    expect(groups.size).toBe(2);
    expect(groups.get("types.ts")).toHaveLength(2);
    expect(groups.get("schemas.ts")).toHaveLength(1);
  });
});

describe("mergeFileRules", () => {
  it("merges plugin defaults with user overrides", () => {
    const pluginDefaults: FileRule[] = [
      { pattern: "type:", fileNaming: () => "types.ts" },
      { pattern: "schema:", fileNaming: () => "schemas.ts" },
    ];

    const userOverrides = [
      { pattern: "type:", file: "my-types.ts" },
    ];

    const merged = mergeFileRules(pluginDefaults, userOverrides);
    expect(merged).toHaveLength(2);
    
    // User override should replace plugin default
    const typeRule = merged.find(r => r.pattern === "type:");
    expect(typeRule!.fileNaming(mockFileNamingContext())).toBe("my-types.ts");
    
    // Schema rule should be preserved
    const schemaRule = merged.find(r => r.pattern === "schema:");
    expect(schemaRule!.fileNaming(mockFileNamingContext())).toBe("schemas.ts");
  });
});
