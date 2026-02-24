/**
 * Effect Schemas Plugin Tests
 *
 * Validates the effect schemas plugin:
 * 1. Generates S.Union(S.Literal(...)) for enum entities
 * 2. Generates domain schemas with constraints via .pipe()
 * 3. Optionally exports inferred type aliases
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { effect } from "../plugins/effect/index.js";
import { effectSchemas } from "../plugins/effect/schemas.js";
import { testIRWithEntities } from "../testing.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR, EnumEntity, DomainEntity, Field, TableEntity, Shape } from "../ir/semantic-ir.js";
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
    outputDir: "generated",
  };
}

function mockEnumEntity(name: string, values: string[]): EnumEntity {
  return {
    kind: "enum",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgType: mockPgType({ typname: name.toLowerCase(), typtype: "e", typcategory: "E" }),
    values,
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function mockDomainEntity(
  name: string,
  baseTypeName: string,
  constraints: DomainEntity["constraints"] = [],
): DomainEntity {
  return {
    kind: "domain",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgType: mockPgType({ typname: name.toLowerCase(), typtype: "d" }),
    baseTypeName,
    baseTypeOid: 25, // text OID
    notNull: false,
    constraints,
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function mockField(name: string, pgTypeName: string, opts?: {
  nullable?: boolean;
  hasDefault?: boolean;
  typtype?: string;
}): Field {
  const nullable = opts?.nullable ?? false;
  const pgType = mockPgType({
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S",
    typtype: opts?.typtype ?? "b",
  });

  return {
    name,
    columnName: name,
    pgAttribute: mockPgAttribute({
      attname: name,
      attnotnull: !nullable,
      atthasdef: opts?.hasDefault ?? false,
      getType: () => pgType,
    }),
    nullable,
    optional: false,
    hasDefault: opts?.hasDefault ?? false,
    isGenerated: false,
    isIdentity: false,
    isArray: pgTypeName.startsWith("_"),
    elementTypeName: pgTypeName.startsWith("_") ? pgTypeName.slice(1) : undefined,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

function mockTableEntity(name: string, rowFields: Field[]): TableEntity {
  const rowShape: Shape = { name, kind: "row", fields: rowFields };
  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: mockPgClass({ relname: name.toLowerCase() }),
    primaryKey: { columns: ["id"], isVirtual: false },
    indexes: [],
    shapes: { row: rowShape },
    relations: [],
    checkConstraints: [],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function runEffectPlugins(ir: SemanticIR, config?: Parameters<typeof effect>[0]) {
  return runPlugins({
    ...testConfig(ir),
    plugins: effect(config ?? {}),
  }).pipe(Effect.map(result => ({
    result,
    files: emitFiles(result),
  })));
}

/** Run only the schemas plugin (no models) so row shapes are generated */
function runSchemasOnly(ir: SemanticIR, config?: { exportTypes?: boolean }) {
  return runPlugins({
    ...testConfig(ir),
    plugins: [effectSchemas({ exportTypes: config?.exportTypes ?? true, repos: true, repoModel: true, http: false })],
  }).pipe(Effect.map(result => ({
    result,
    files: emitFiles(result),
  })));
}

function printFile(files: readonly { path: string; content: string }[], path: string): string {
  const file = files.find(f => f.path.includes(path));
  return file?.content ?? "";
}

// =============================================================================
// Enum Schema Tests
// =============================================================================

describe("Effect Schemas Plugin - Enums", () => {
  it.effect("generates S.Union(S.Literal(...)) for enum entities", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockEnumEntity("UserRole", ["admin", "user", "moderator"]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:UserRole");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.Union");
      expect(code).toContain('S.Literal("admin")');
      expect(code).toContain('S.Literal("user")');
      expect(code).toContain('S.Literal("moderator")');
    }),
  );

  it.effect("generates type aliases when exportTypes is true", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockEnumEntity("Status", ["active", "inactive"]),
      ]);

      const { result } = yield* runEffectPlugins(ir, { exportTypes: true });

      const typeDecl = result.rendered.find(d => d.capability === "effect:schema:Status:type");
      expect(typeDecl).toBeDefined();

      const code = recast.print(typeDecl!.node).code;
      expect(code).toContain("StatusType");
    }),
  );
});

// =============================================================================
// Domain Schema Tests
// =============================================================================

describe("Effect Schemas Plugin - Domains", () => {
  it.effect("generates base schema for domain without constraints", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Email", "text"),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:Email");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.String");
    }),
  );

  it.effect("applies minLength and maxLength constraints", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Username", "text", [
          {
            name: "username_length",
            validations: [
              { kind: "minLength", value: 3 },
              { kind: "maxLength", value: 50 },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:Username");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.String");
      expect(code).toContain("pipe");
      expect(code).toContain("S.minLength(3)");
      expect(code).toContain("S.maxLength(50)");
    }),
  );

  it.effect("applies numeric range constraints", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Rating", "int4", [
          {
            name: "rating_range",
            validations: [
              { kind: "min", value: 0 },
              { kind: "max", value: 5 },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:Rating");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.Number");
      expect(code).toContain("pipe");
      expect(code).toContain("S.greaterThanOrEqualTo(0)");
      expect(code).toContain("S.lessThanOrEqualTo(5)");
    }),
  );

  it.effect("applies regex pattern constraint", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Slug", "text", [
          {
            name: "slug_format",
            validations: [
              { kind: "regex", pattern: "^[a-z0-9-]+$" },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:Slug");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.String");
      expect(code).toContain("S.pattern");
      expect(code).toContain("^[a-z0-9-]+$");
    }),
  );

  it.effect("applies case-insensitive regex constraint", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("EmailAddr", "citext", [
          {
            name: "email_format",
            validations: [
              { kind: "regex", pattern: "^[^@]+@[^@]+$", caseInsensitive: true },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:EmailAddr");
      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.pattern");
      // Case-insensitive flag
      expect(code).toMatch(/\/i\b/);
    }),
  );

  it.effect("combines multiple constraints from multiple domain constraints", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Username", "text", [
          {
            name: "username_length",
            validations: [
              { kind: "minLength", value: 2 },
              { kind: "maxLength", value: 24 },
            ],
          },
          {
            name: "username_format",
            validations: [
              { kind: "regex", pattern: "^[a-zA-Z][a-zA-Z0-9_-]+$" },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:Username");
      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.minLength(2)");
      expect(code).toContain("S.maxLength(24)");
      expect(code).toContain("S.pattern");
    }),
  );

  it.effect("skips unknown validations gracefully", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("WeirdDomain", "text", [
          {
            name: "weird_check",
            validations: [
              { kind: "unknown", raw: "VALUE IS NOT NULL" },
              { kind: "minLength", value: 1 },
            ],
          },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:WeirdDomain");
      const code = recast.print(schemaDecl!.node).code;
      // Should still have minLength, unknown constraint is skipped
      expect(code).toContain("S.minLength(1)");
      expect(code).not.toContain("IS NOT NULL");
    }),
  );

  it.effect("generates type aliases for domains when exportTypes is true", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        mockDomainEntity("Username", "text", [
          { name: "check", validations: [{ kind: "minLength", value: 1 }] },
        ]),
      ]);

      const { result } = yield* runEffectPlugins(ir, { exportTypes: true });

      const typeDecl = result.rendered.find(d => d.capability === "effect:schema:Username:type");
      expect(typeDecl).toBeDefined();

      const code = recast.print(typeDecl!.node).code;
      expect(code).toContain("UsernameType");
    }),
  );
});

// =============================================================================
// Table Schema Tests
// =============================================================================

describe("Effect Schemas Plugin - Tables", () => {
  it.effect("generates S.Struct for row shape", () =>
    Effect.gen(function* () {
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
        mockField("age", "int4"),
        mockField("active", "bool"),
      ]);

      const ir = testIRWithEntities([table]);
      const { result } = yield* runSchemasOnly(ir);

      const schemaDecl = result.rendered.find(d => d.capability === "effect:schema:User");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.Struct");
      expect(code).toContain("S.UUID");
      expect(code).toContain("S.String");
      expect(code).toContain("S.Number");
      expect(code).toContain("S.Boolean");
    }),
  );

  it.effect("generates schemas for all shape variants (row, insert, update)", () =>
    Effect.gen(function* () {
      const fields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("name", "text"),
      ];

      const insertFields = [
        mockField("name", "text"),
      ];

      const updateFields = [
        mockField("name", "text", { nullable: false }),
      ];

      // Manually build entity with multiple shapes
      const entity: TableEntity = {
        kind: "table",
        name: "Post",
        pgName: "post",
        schemaName: "public",
        pgClass: mockPgClass({ relname: "post" }),
        primaryKey: { columns: ["id"], isVirtual: false },
        indexes: [],
        shapes: {
          row: { name: "Post", kind: "row", fields },
          insert: { name: "PostInsert", kind: "insert", fields: insertFields },
          update: { name: "PostUpdate", kind: "update", fields: updateFields.map(f => ({ ...f, optional: true })) },
        },
        relations: [],
        checkConstraints: [],
        tags: {},
        permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      expect(result.rendered.find(d => d.capability === "effect:schema:Post")).toBeDefined();
      expect(result.rendered.find(d => d.capability === "effect:schema:PostInsert")).toBeDefined();
      expect(result.rendered.find(d => d.capability === "effect:schema:PostUpdate")).toBeDefined();
    }),
  );

  it.effect("handles nullable fields with S.NullOr", () =>
    Effect.gen(function* () {
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("bio", "text", { nullable: true }),
      ]);

      const ir = testIRWithEntities([table]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      expect(code).toContain("S.NullOr");
    }),
  );

  it.effect("handles array fields with S.Array", () =>
    Effect.gen(function* () {
      const table = mockTableEntity("Post", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("tags", "_text"),
      ]);

      const ir = testIRWithEntities([table]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:Post")!.node).code;
      expect(code).toContain("S.Array");
    }),
  );

  it.effect("references enum schemas in table fields", () =>
    Effect.gen(function* () {
      const enumEntity = mockEnumEntity("UserRole", ["admin", "user"]);
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("role", "userrole", { typtype: "e" }),
      ]);

      const ir = testIRWithEntities([enumEntity, table]);
      const { result } = yield* runSchemasOnly(ir);

      // Enum schema should be generated
      expect(result.rendered.find(d => d.capability === "effect:schema:UserRole")).toBeDefined();

      // Table schema should reference it (via registry import)
      const tableDecl = result.rendered.find(d => d.capability === "effect:schema:User");
      expect(tableDecl).toBeDefined();
    }),
  );

  it.effect("references domain schemas in table fields", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Username", "text", [
        { name: "check", validations: [{ kind: "minLength", value: 3 }] },
      ]);
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("username", "username", { typtype: "d" }),
      ]);

      const ir = testIRWithEntities([domain, table]);
      const { result } = yield* runSchemasOnly(ir);

      // Domain schema should be generated with constraint
      const domainDecl = result.rendered.find(d => d.capability === "effect:schema:Username");
      expect(domainDecl).toBeDefined();
      expect(recast.print(domainDecl!.node).code).toContain("S.minLength(3)");

      // Table schema should exist
      const tableDecl = result.rendered.find(d => d.capability === "effect:schema:User");
      expect(tableDecl).toBeDefined();
    }),
  );

  it.effect("generates type aliases for table shapes when exportTypes is true", () =>
    Effect.gen(function* () {
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ]);

      const ir = testIRWithEntities([table]);
      const { result } = yield* runSchemasOnly(ir, { exportTypes: true });

      const typeDecl = result.rendered.find(d => d.capability === "effect:schema:User:type");
      expect(typeDecl).toBeDefined();

      const code = recast.print(typeDecl!.node).code;
      expect(code).toContain("UserType");
    }),
  );

  it.effect("does not generate type aliases when exportTypes is false", () =>
    Effect.gen(function* () {
      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ]);

      const ir = testIRWithEntities([table]);
      const { result } = yield* runSchemasOnly(ir, { exportTypes: false });

      expect(result.rendered.find(d => d.capability === "effect:schema:User:type")).toBeUndefined();
    }),
  );
});

// =============================================================================
// CHECK Constraint Tests
// =============================================================================

describe("Effect Schemas Plugin - CHECK Constraints", () => {
  it.effect("applies minLength CHECK constraint via .pipe()", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
        ]),
        checkConstraints: [
          { name: "user_name_min", definition: "CHECK ((length(name) > 2))", columns: ["name"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      expect(code).toContain("S.minLength(3)");
      expect(code).toContain(".pipe(");
    }),
  );

  it.effect("applies maxLength CHECK constraint via .pipe()", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
        ]),
        checkConstraints: [
          { name: "user_name_max", definition: "CHECK ((length(name) <= 100))", columns: ["name"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      expect(code).toContain("S.maxLength(100)");
    }),
  );

  it.effect("applies lengthRange CHECK constraint as minLength + maxLength", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
        ]),
        checkConstraints: [
          {
            name: "user_name_len",
            definition: "CHECK ((length(name) > 1 AND length(name) <= 50))",
            columns: ["name"],
          },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      expect(code).toContain("S.minLength(2)");
      expect(code).toContain("S.maxLength(50)");
    }),
  );

  it.effect("applies numeric min CHECK constraint as greaterThanOrEqualTo", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("Product", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("price", "numeric"),
        ]),
        checkConstraints: [
          { name: "product_price_min", definition: "CHECK ((price >= 0))", columns: ["price"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:Product")!.node).code;
      expect(code).toContain("S.greaterThanOrEqualTo(0)");
    }),
  );

  it.effect("applies numeric range CHECK constraint as greaterThanOrEqualTo + lessThanOrEqualTo", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("Product", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("rating", "int4"),
        ]),
        checkConstraints: [
          {
            name: "product_rating_range",
            definition: "CHECK ((rating >= 1 AND rating <= 5))",
            columns: ["rating"],
          },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:Product")!.node).code;
      expect(code).toContain("S.greaterThanOrEqualTo(1)");
      expect(code).toContain("S.lessThanOrEqualTo(5)");
    }),
  );

  it.effect("applies regex CHECK constraint as pattern", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("slug", "text"),
        ]),
        checkConstraints: [
          { name: "user_slug_format", definition: "CHECK ((slug ~ '^[a-z0-9-]+$'))", columns: ["slug"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      expect(code).toContain("S.pattern(");
      expect(code).toContain("[a-z0-9-]+$");
    }),
  );

  it.effect("applies multiple CHECK constraints to different fields", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("Product", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
          mockField("price", "numeric"),
        ]),
        checkConstraints: [
          { name: "product_name_len", definition: "CHECK ((length(name) > 0))", columns: ["name"] },
          { name: "product_price_min", definition: "CHECK ((price >= 0))", columns: ["price"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:Product")!.node).code;
      expect(code).toContain("S.minLength(1)");
      expect(code).toContain("S.greaterThanOrEqualTo(0)");
    }),
  );

  it.effect("ignores CHECK constraints for columns not in the shape", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
        ]),
        checkConstraints: [
          { name: "other_col_check", definition: "CHECK ((other_col >= 0))", columns: ["other_col"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      // Should not have .pipe() since no constraints apply
      expect(code).not.toContain(".pipe(");
      expect(code).not.toContain("greaterThanOrEqualTo");
    }),
  );

  it.effect("skips unknown/unparseable CHECK constraints gracefully", () =>
    Effect.gen(function* () {
      const entity: TableEntity = {
        ...mockTableEntity("User", [
          mockField("id", "uuid", { hasDefault: true }),
          mockField("name", "text"),
        ]),
        checkConstraints: [
          { name: "complex_check", definition: "CHECK ((name IS DISTINCT FROM ''))", columns: ["name"] },
        ],
      };

      const ir = testIRWithEntities([entity]);
      const { result } = yield* runSchemasOnly(ir);

      const code = recast.print(result.rendered.find(d => d.capability === "effect:schema:User")!.node).code;
      // Unknown constraints should be skipped, no .pipe() added
      expect(code).toContain("S.String");
      expect(code).not.toContain(".pipe(");
    }),
  );
});

// =============================================================================
// Domain Reference in Models Tests
// =============================================================================

describe("Effect Models Plugin - Domain References", () => {
  it.effect("references domain schema in Model.Class fields", () =>
    Effect.gen(function* () {
      const domain = mockDomainEntity("Username", "text", [
        { name: "check", validations: [{ kind: "minLength", value: 3 }] },
      ]);

      const table = mockTableEntity("User", [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("username", "username", { typtype: "d" }),
        mockField("email", "text"),
      ]);

      const ir = testIRWithEntities([domain, table]);
      const { files } = yield* runEffectPlugins(ir);

      // The model file should reference the domain schema
      const modelFile = files.find(f => f.path.includes("user") && !f.path.includes("schema"));
      if (modelFile) {
        expect(modelFile.content).toContain("Username");
      }

      // The domain schema file should have the constraint
      const schemaDecl = (yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({}),
      })).rendered.find(d => d.capability === "effect:schema:Username");

      expect(schemaDecl).toBeDefined();
      const code = recast.print(schemaDecl!.node).code;
      expect(code).toContain("S.minLength(3)");
    }),
  );
});
