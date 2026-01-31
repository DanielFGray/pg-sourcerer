/**
 * Test domain support in Zod plugin
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { zod } from "../plugins/zod.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRFromFixture, testIRWithEntities } from "../testing.js";
import type { TableEntity, Field, DomainEntity, SemanticIR, Entity } from "../ir/semantic-ir.js";
import { mockPgAttribute, mockPgClass, mockPgType } from "./mocks/pg-introspection.js";

// =============================================================================
// Test Helpers
// =============================================================================

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "src/generated",
  };
}

function mockField(name: string, pgTypeName: string, opts?: { nullable?: boolean }): Field {
  const nullable = opts?.nullable ?? false;

  const pgType = mockPgType({
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S",
    typtype: "b",
  });

  const pgAttribute = mockPgAttribute({
    attname: name,
    attnotnull: !nullable,
    atthasdef: false,
    attgenerated: "",
    attidentity: "",
    getType: () => pgType,
  });

  return {
    name,
    columnName: name,
    pgAttribute,
    nullable,
    optional: false,
    hasDefault: false,
    isGenerated: false,
    isIdentity: false,
    isArray: pgTypeName.startsWith("_"),
    elementTypeName: pgTypeName.startsWith("_") ? pgTypeName.slice(1) : undefined,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

function mockTableEntity(name: string, fields: Field[]): TableEntity {
  const pgType = mockPgType({ typname: "uuid", typcategory: "U", typtype: "b" });
  const pgAttribute = mockPgAttribute({
    attname: "id",
    attnotnull: true,
    atthasdef: false,
    attgenerated: "",
    attidentity: "",
    getType: () => pgType,
  });

  const idField: Field = {
    name: "id",
    columnName: "id",
    pgAttribute,
    nullable: false,
    optional: false,
    hasDefault: false,
    isGenerated: false,
    isIdentity: false,
    isArray: false,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };

  const rowShape = {
    name: `${name}Row`,
    kind: "row" as const,
    fields: [idField, ...fields],
  };

  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: mockPgClass({ relname: name.toLowerCase() }),
    primaryKey: { columns: ["id"], isVirtual: false },
    indexes: [],
    checkConstraints: [],
    shapes: { row: rowShape },
    relations: [],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function mockDomainEntity(name: string, pgName: string, constraints: DomainEntity["constraints"] = []): DomainEntity {
  return {
    kind: "domain",
    name,
    pgName,
    schemaName: "public",
    baseTypeName: "text",
    baseTypeOid: 25,
    notNull: true,
    constraints,
    pgType: mockPgType({ typname: pgName, typcategory: "S", typtype: "d" }),
    tags: {},
  };
}

// =============================================================================
// Declare Phase Tests
// =============================================================================

describe("Zod Plugin - Domain Declare", () => {
  it.effect("declares schema:zod:DomainName for each domain entity", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Email", "email", [
        { name: "email_format", validations: [{ kind: "regex", pattern: "^[^@]+@[^@]+$" }] },
      ]);

      const ir = testIRWithEntities([domain]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      expect(result.declarations.length).toBeGreaterThan(0);

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).toContain("schema:zod:Email");

      const names = result.declarations.map(d => d.name);
      expect(names).toContain("Email");
    }),
  );

  it.effect("declares schema:zod:DomainName:type when exportTypes=true", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Username", "username", []);

      const ir = testIRWithEntities([domain]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod({ exportTypes: true })] });

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).toContain("schema:zod:Username:type");
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Zod Plugin - Domain Render", () => {
  it.effect("renders domain schema with constraints", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Username", "username", [
        { name: "min_length", validations: [{ kind: "minLength", value: 3 }] },
        { name: "max_length", validations: [{ kind: "maxLength", value: 50 }] },
      ]);

      const ir = testIRWithEntities([domain]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      expect(result.rendered.length).toBeGreaterThan(0);

      const rendered = result.rendered.find(r => r.capability === "schema:zod:Username");
      expect(rendered).toBeDefined();

      if (rendered) {
        const code = recast.print(rendered.node!).code;
        expect(code).toContain("export const Username");
        expect(code).toContain("min(3)");
        expect(code).toContain("max(50)");
      }
    }),
  );

  it.effect("renders regex constraints correctly", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Email", "email", [
        { name: "email_format", validations: [{ kind: "regex", pattern: "^[^@]+@[^@]+$" }] },
      ]);

      const ir = testIRWithEntities([domain]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const rendered = result.rendered.find(r => r.capability === "schema:zod:Email");
      expect(rendered).toBeDefined();

      if (rendered) {
        const code = recast.print(rendered.node!).code;
        // z.string().regex() accepts both regex literals and string patterns
        expect(code).toContain('regex("^[^@]+@[^@]+$")');
      }
    }),
  );

  it.effect("renders domain type inference when exportTypes=true", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Username", "username", []);

      const ir = testIRWithEntities([domain]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod({ exportTypes: true })] });

      const rendered = result.rendered.find(r => r.capability === "schema:zod:Username:type");
      expect(rendered).toBeDefined();

      if (rendered) {
        const code = recast.print(rendered.node!).code;
        expect(code).toContain("export type Username");
        expect(code).toContain("z.infer<typeof Username>");
      }
    }),
  );
});

// =============================================================================
// Table Field References Tests
// =============================================================================

describe("Zod Plugin - Domain Field References", () => {
  it.effect("table fields using domain reference domain schema", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Email", "email", [
        { name: "email_format", validations: [{ kind: "regex", pattern: "^[^@]+@[^@]+$" }] },
      ]);

      // Mock a field that uses the domain
      const domainType = mockPgType({ typname: "email", typcategory: "S", typtype: "d" });
      const domainAttr = mockPgAttribute({
        attname: "email",
        attnotnull: true,
        atthasdef: false,
        attgenerated: "",
        attidentity: "",
        getType: () => domainType,
      });

      const emailField: Field = {
        name: "email",
        columnName: "email",
        pgAttribute: domainAttr,
        nullable: false,
        optional: false,
        hasDefault: false,
        isGenerated: false,
        isIdentity: false,
        isArray: false,
        tags: {},
        extensions: new Map(),
        permissions: { canSelect: true, canInsert: true, canUpdate: true },
      };

      const table = mockTableEntity("User", [emailField]);

      const ir = testIRWithEntities([domain, table]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      // Find the table schema
      const tableRendered = result.rendered.find(r => r.capability === "schema:zod:UserRow");
      expect(tableRendered).toBeDefined();

      if (tableRendered) {
        const code = recast.print(tableRendered.node!).code;
        // The field should reference the Email schema, not inline z.string()
        expect(code).toContain("email: Email");
      }
    }),
  );
});
