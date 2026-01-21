/**
 * Effect HTTP Plugin Tests
 *
 * Validates the effect HTTP plugin:
 * 1. Correctly declares effect:http:EntityName for entities with repos
 * 2. Renders valid @effect/platform HttpApi code
 * 3. Generates NotFound error classes
 * 4. Generates ApiGroup, Api, Handlers, and ApiLive for each entity
 * 5. Generates Server aggregator
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { effect } from "../plugins/effect/index.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field, SemanticIR } from "../ir/semantic-ir.js";
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

/**
 * Create a minimal mock Field for testing.
 */
function mockField(name: string, pgTypeName: string, opts?: { 
  nullable?: boolean;
  hasDefault?: boolean;
  isGenerated?: boolean;
  isIdentity?: boolean;
}): Field {
  const nullable = opts?.nullable ?? false;

  const pgType = mockPgType({
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S",
    typtype: "b",
  });

  const pgAttribute = mockPgAttribute({
    attname: name,
    attnotnull: !nullable,
    atthasdef: opts?.hasDefault ?? false,
    attgenerated: opts?.isGenerated ? "s" : "",
    attidentity: opts?.isIdentity ? "a" : "",
    getType: () => pgType,
  });

  return {
    name,
    columnName: name,
    pgAttribute,
    nullable,
    optional: false,
    hasDefault: opts?.hasDefault ?? false,
    isGenerated: opts?.isGenerated ?? false,
    isIdentity: opts?.isIdentity ?? false,
    isArray: pgTypeName.startsWith("_"),
    elementTypeName: pgTypeName.startsWith("_") ? pgTypeName.slice(1) : undefined,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

/**
 * Create a minimal mock Shape for testing.
 */
function mockShape(name: string, kind: "row" | "insert" | "update", fields: Field[]): Shape {
  return {
    name,
    kind,
    fields,
  };
}

/**
 * Create a minimal mock TableEntity with single-column PK (required for repos/http).
 */
function mockTableEntity(name: string, rowFields: Field[], opts?: {
  primaryKey?: TableEntity["primaryKey"];
  permissions?: TableEntity["permissions"];
  omit?: boolean;
}): TableEntity {
  const rowShape = mockShape(name, "row", rowFields);

  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: mockPgClass({ relname: name.toLowerCase() }),
    primaryKey: opts?.primaryKey ?? { columns: ["id"], isVirtual: false },
    indexes: [],
    shapes: { row: rowShape },
    relations: [],
    tags: { omit: opts?.omit },
    permissions: opts?.permissions ?? { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

// =============================================================================
// Declare Phase Tests
// =============================================================================

describe("Effect HTTP Plugin - Declare", () => {
  it.effect("declares effect:http:EntityName for entities with single-column PK", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
        mockField("created_at", "timestamptz", { hasDefault: true }),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const httpDecls = result.declarations.filter(d => d.capability.startsWith("effect:http:"));
      
      // Should have 5 declarations per entity (NotFound, ApiGroup, Api, ApiGroupLive, ApiLive) + Server
      expect(httpDecls.length).toBeGreaterThanOrEqual(6);
      
      // Check for any User-related declaration
      const userApi = httpDecls.find(d => d.capability.startsWith("effect:http:User:"));
      expect(userApi).toBeDefined();
      
      const server = httpDecls.find(d => d.capability === "effect:http:server");
      expect(server).toBeDefined();
    }),
  );

  it.effect("does not declare HTTP for entities without single-column PK", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("tenant_id", "uuid"),
        mockField("user_id", "uuid"),
        mockField("email", "text"),
      ];

      // Composite primary key
      const ir = testIRWithEntities([
        mockTableEntity("TenantUser", userFields, {
          primaryKey: { columns: ["tenant_id", "user_id"], isVirtual: false },
        }),
      ]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const httpDecls = result.declarations.filter(d => 
        d.capability.startsWith("effect:http:") && d.capability !== "effect:http:server"
      );
      
      // No entity-specific HTTP declarations (composite PK not supported)
      expect(httpDecls).toHaveLength(0);
    }),
  );

  it.effect("does not declare HTTP when http config is disabled", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: false }),
      });

      const httpDecls = result.declarations.filter(d => d.capability.startsWith("effect:http:"));
      expect(httpDecls).toHaveLength(0);
    }),
  );

  it.effect("does not declare HTTP for entities with omit tag", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields, { omit: true })]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const httpDecls = result.declarations.filter(d => 
        d.capability.startsWith("effect:http:") && d.capability !== "effect:http:server"
      );
      expect(httpDecls).toHaveLength(0);
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Effect HTTP Plugin - Render", () => {
  it.effect("renders NotFound error class", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const httpRendered = result.rendered.filter(r => r.capability.startsWith("effect:http:User:"));
      expect(httpRendered.length).toBeGreaterThanOrEqual(1);

      // Find entity file containing HTTP code (now in same file as model/repo)
      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();
      
      const content = userFile!.content;
      expect(content).toContain("UserNotFound");
      expect(content).toContain("S.TaggedError");
    }),
  );

  it.effect("renders HttpApiGroup with CRUD endpoints", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      // Should have ApiGroup
      expect(content).toContain("HttpApiGroup.make");
      expect(content).toContain("UserApiGroup");
      
      // Should have CRUD endpoints (no list - repos don't have findAll)
      expect(content).toContain("HttpApiEndpoint.get");
      expect(content).toContain("HttpApiEndpoint.post");
      expect(content).toContain("HttpApiEndpoint.put");
      expect(content).toContain("HttpApiEndpoint.del");
      
      // Should have findById endpoint with path param
      expect(content).toContain("findById");
      expect(content).toContain("HttpApiSchema.param");
    }),
  );

  it.effect("renders HttpApi wrapper", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      expect(content).toContain("HttpApi.make");
      expect(content).toContain("UserApi");
      expect(content).toContain(".add(UserApiGroup)");
    }),
  );

  it.effect("renders handlers using repo methods", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      // Should have handlers
      expect(content).toContain("HttpApiBuilder.group");
      expect(content).toContain("UserApiGroupLive");
      
      // Should use repo methods
      expect(content).toContain("UserRepo");
      expect(content).toContain("repo.findById");
      expect(content).toContain("repo.insert");
      expect(content).toContain("repo.update");
      expect(content).toContain("repo.delete");
      
      // Should handle Option for findById
      expect(content).toContain("Option.match");
    }),
  );

  it.effect("renders ApiLive layer with repo dependency", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      expect(content).toContain("UserApiLive");
      expect(content).toContain("HttpApiBuilder.api");
      expect(content).toContain("Layer.provide");
      expect(content).toContain("UserRepo.Default");
    }),
  );

  it.effect("uses correct PK schema type for UUID", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      // UUID PK should use S.UUID for path param
      expect(content).toContain("S.UUID");
    }),
  );

  it.effect("uses correct PK schema type for integer", () =>
    Effect.gen(function* () {
      const postFields = [
        mockField("id", "int4", { hasDefault: true }),
        mockField("title", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("Post", postFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const postFile = files.find(f => f.path === "post.ts");
      expect(postFile).toBeDefined();

      const content = postFile!.content;
      // Integer PK should use S.NumberFromString for path param
      expect(content).toContain("S.NumberFromString");
    }),
  );
});

// =============================================================================
// Server Aggregator Tests
// =============================================================================

describe("Effect HTTP Plugin - Server Aggregator", () => {
  it.effect("generates Server.ts with all ApiLive layers", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];
      const postFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("title", "text"),
      ];

      const ir = testIRWithEntities([
        mockTableEntity("User", userFields),
        mockTableEntity("Post", postFields),
      ]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const serverFile = files.find(f => f.path === "server.ts");
      expect(serverFile).toBeDefined();

      const content = serverFile!.content;
      
      expect(content).toContain("ServerLive");
      expect(content).toContain("HttpApiBuilder.serve");
      expect(content).toContain("Layer.provide");
      expect(content).toContain("UserApiLive");
      expect(content).toContain("PostApiLive");
    }),
  );
});

// =============================================================================
// Config Tests
// =============================================================================

describe("Effect HTTP Plugin - Config", () => {
  it.effect("respects basePath config", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true, basePath: "/v1" } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      // Should have configured base path
      expect(content).toContain("/v1");
    }),
  );

  it.effect("serverFile config controls server aggregator location", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true, serverFile: "http/server.ts" } }),
      });

      const files = emitFiles(result);
      
      // Server file should be at configured path
      const serverFile = files.find(f => f.path === "http/server.ts");
      expect(serverFile).toBeDefined();
      
      // Entity HTTP code stays in the entity file (not affected by serverFile)
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();
    }),
  );
});

// =============================================================================
// Import Tests
// =============================================================================

describe("Effect HTTP Plugin - Imports", () => {
  it.effect("includes required @effect/platform imports", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      expect(content).toContain('from "@effect/platform"');
      expect(content).toContain("HttpApi");
      expect(content).toContain("HttpApiBuilder");
      expect(content).toContain("HttpApiEndpoint");
      expect(content).toContain("HttpApiGroup");
      expect(content).toContain("HttpApiSchema");
    }),
  );

  it.effect("includes effect imports", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      expect(content).toContain('from "effect"');
      expect(content).toContain("Effect");
      expect(content).toContain("Layer");
      expect(content).toContain("Option");
      expect(content).toContain("Schema as S");
    }),
  );

  it.effect("HTTP code in same file has access to Model and Repo", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid", { hasDefault: true }),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({
        ...testConfig(ir),
        plugins: effect({ http: { enabled: true } }),
      });

      const files = emitFiles(result);
      const userFile = files.find(f => f.path === "user.ts");
      expect(userFile).toBeDefined();

      const content = userFile!.content;
      
      // HTTP code uses User model and UserRepo (defined in same file)
      expect(content).toContain("User");
      expect(content).toContain("UserRepo");
      // Should NOT have cross-file imports for model/repo since they're in the same file
    }),
  );
});
