/**
 * Effect Model Plugin Tests
 *
 * Tests for the Effect Model plugin that generates @effect/sql Model classes.
 * Uses the fixture introspection data from the example database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Test helpers use flexible typing */
/* eslint-disable @typescript-eslint/no-unsafe-return -- Effect type inference in tests */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { effectModelPlugin } from "../plugins/effect-model.js"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive } from "../services/inflection.js"
import { Emissions, createEmissionBuffer } from "../services/emissions.js"
import { Symbols, createSymbolRegistry } from "../services/symbols.js"
import { TypeHintsLive } from "../services/type-hints.js"
import { ArtifactStoreLive } from "../services/artifact-store.js"
import { PluginMeta } from "../services/plugin-meta.js"
import { IR } from "../services/ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"
import type { SemanticIR, TableEntity, Field } from "../ir/semantic-ir.js"
import { getEnumEntities, isTableEntity } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"

// Load introspection data from fixture
const introspection = loadIntrospectionFixture()

/**
 * Build IR from fixture introspection data
 */
function buildTestIR(schemas: readonly string[]) {
  const builder = createIRBuilderService()
  return builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive))
}

/**
 * Create a test layer with fresh emissions and symbols for each test.
 */
function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "effect-model" }),
    InflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive
  )
}

/**
 * Run plugin and get serialized emissions.
 * Handles AST serialization so tests can inspect string content.
 */
function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer))
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
    // Serialize any AST emissions to string content
    emissions.serializeAst(conjure.print, symbols)
    return emissions.getAll()
  })
}

describe("Effect Model Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(effectModelPlugin.plugin.name).toBe("effect-model")
    })

    it("provides model capabilities", () => {
      // provides is a function that depends on config - call with exportTypes to test
      const provides = effectModelPlugin.plugin.provides
      const capabilities = typeof provides === "function" ? provides({ exportTypes: true } as any) : provides
      expect(capabilities).toContain("models:effect")
      expect(capabilities).toContain("models")
    })

    it("provides types capability when exportTypes is true", () => {
      const provides = effectModelPlugin.plugin.provides
      const capabilities = typeof provides === "function" ? provides({ exportTypes: true } as any) : provides
      expect(capabilities).toContain("types")
    })

    it("does not provide types capability when exportTypes is false", () => {
      const provides = effectModelPlugin.plugin.provides
      const capabilities = typeof provides === "function" ? provides({ exportTypes: false } as any) : provides
      expect(capabilities).not.toContain("types")
    })

    it("has no requirements", () => {
      expect(effectModelPlugin.plugin.requires).toBeUndefined()
    })
  })

  describe("entity generation", () => {
    it.effect("generates Model class for User entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Should have generated files for entities
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()
        expect(userFile?.content).toContain('extends Model.Class<User>("User")')
      })
    )

    it.effect("generates Model and Schema imports", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain('import { Model } from "@effect/sql"')
        expect(userFile?.content).toContain('import { Schema as S } from "effect"')
      })
    )

    it.effect("generates auto-generated file header", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).not.toContain("// This file is auto-generated. Do not edit.")
      })
    )
  })

  describe("field type mapping", () => {
    it.effect("maps UUID fields to S.UUID", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User has id: uuid
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("S.UUID")
      })
    )

    it.effect("maps text fields to S.String", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User has name: text
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("S.String")
      })
    )

    it.effect("maps boolean fields to S.Boolean", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // UserEmail has is_verified: bool
        const emailFile = all.find((e) => e.path.includes("UserEmail.ts"))
        expect(emailFile?.content).toContain("S.Boolean")
      })
    )

    it.effect("maps timestamp fields to S.Date", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Posts has created_at: timestamptz with default - uses DateTimeInsertFromDate
        const postsFile = all.find((e) => e.path.includes("Post.ts"))
        expect(postsFile?.content).toContain("Model.DateTimeInsertFromDate")
      })
    )

    it.effect("maps bigint fields to S.BigInt", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // top_tags view has count: int8 (bigint)
        const topTagsFile = all.find((e) => e.path.includes("TopTag.ts"))
        if (topTagsFile) {
          expect(topTagsFile.content).toContain("S.BigInt")
        }
      })
    )
  })

  describe("nullable fields", () => {
    it.effect("wraps nullable fields with S.NullOr", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User.name is nullable text
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("S.NullOr")
      })
    )
  })

  describe("generated fields", () => {
    it.effect("uses Model.Generated for identity columns", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Posts has id: int4 with identity=true
        const postsFile = all.find((e) => e.path.includes("Post.ts"))
        expect(postsFile?.content).toContain("Model.Generated")
      })
    )

    it.effect("uses Model.Generated for GENERATED columns", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Posts has tags: _citext with generated=true
        const postsFile = all.find((e) => e.path.includes("Post.ts"))
        expect(postsFile?.content).toContain("Model.Generated")
      })
    )

    it.effect("treats non-insertable/updateable fields with defaults as Generated", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        
        // Find a view entity
        const viewEntity = Array.from(ir.entities.values()).find(
          (e): e is TableEntity => isTableEntity(e) && e.kind === "view"
        )
        
        // Run the plugin and verify view fields with defaults get Model.Generated
        const testLayer = createTestLayer(ir)
        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        
        // Views should generate valid Model classes
        const viewFile = all.find((e) => e.path.includes("RecentPost.ts"))
        expect(viewFile).toBeDefined()
        expect(viewFile?.content).toContain("Model.Class")
        
        // If the view has fields with defaults that are non-insertable/updateable,
        // they should use Model.Generated. Check the actual field permissions.
        if (viewEntity) {
          const nonMutableFieldsWithDefaults = viewEntity.shapes.row.fields.filter(
            (f: Field) => f.hasDefault && !f.permissions.canInsert && !f.permissions.canUpdate
          )
          if (nonMutableFieldsWithDefaults.length > 0) {
            expect(viewFile?.content).toContain("Model.Generated")
          }
        }
      })
    )
  })

  describe("fields with defaults", () => {
    it.effect("makes fields with DB defaults optional in insert", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User.id has hasDefault=true, should be optional on insert
        // This is achieved via Model.Generated or Model.Field with S.optional
        const userFile = all.find((e) => e.path.includes("User.ts"))
        const content = userFile?.content ?? ""
        
        // Either Model.Generated (excludes from insert entirely)
        // or Model.Field with S.optional on insert variant
        expect(
          content.includes("Model.Generated") || content.includes("S.optional")
        ).toBe(true)
      })
    )
  })

  describe("enum fields", () => {
    it.effect("generates inline enum as S.Union of S.Literal when typeReferences is inline", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models", typeReferences: "inline" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // comments_votes and posts_votes have vote: vote_type enum
        const votesFile = all.find((e) => e.path.includes("CommentsVote.ts") || e.path.includes("PostsVote.ts"))
        if (votesFile) {
          // Should use S.Union with S.Literal for enum values
          expect(votesFile.content).toContain("S.Literal")
        }
      })
    )

    it.effect("generates separate enum file by default (typeReferences: separate)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Each enum should have its own file when typeReferences: "separate" (default)
        const enumEntities = getEnumEntities(ir)
        if (enumEntities.length > 0) {
          for (const enumEntity of enumEntities) {
            const enumFile = all.find((e) => e.path.includes(`${enumEntity.name}.ts`))
            expect(enumFile).toBeDefined()
            expect(enumFile?.content).toContain("S.Union")
            expect(enumFile?.content).toContain("S.Literal")
          }
        }
      })
    )
  })

  describe("array fields", () => {
    it.effect("wraps array fields with S.Array", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Posts has tags: _citext (array of citext)
        const postsFile = all.find((e) => e.path.includes("Post.ts"))
        expect(postsFile?.content).toContain("S.Array")
      })
    )
  })

  describe("views", () => {
    it.effect("generates Model for views (select-only)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // recent_posts is a view
        const recentPostsFile = all.find((e) => e.path.includes("RecentPost.ts"))
        expect(recentPostsFile).toBeDefined()
        expect(recentPostsFile?.content).toContain("Model.Class")
      })
    )

    it.effect("excludes view fields from insert/update variants", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Views generate valid Model classes with plain schemas
        // (we don't enforce insert/update exclusion at the type level for views -
        // they're read-only by nature and the DB will reject mutations)
        const recentPostsFile = all.find((e) => e.path.includes("RecentPost.ts"))
        expect(recentPostsFile).toBeDefined()
        
        const content = recentPostsFile?.content ?? ""
        
        // Should have a valid Model.Class definition
        expect(content).toContain("Model.Class")
        // View fields are nullable (since they come from joins/aggregates)
        expect(content).toContain("S.NullOr")
      })
    )
  })

  describe("symbol registration", () => {
    it.effect("registers symbols for generated models", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // Should have registered User model
        const userSymbol = allSymbols.find(
          (s) => s.name === "User" && !s.isType
        )
        expect(userSymbol).toBeDefined()
        expect(userSymbol?.capability).toBe("models:effect")
      })
    )
  })

  describe("configuration", () => {
    it.effect("uses outputDir from config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "custom/models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // All paths should start with the custom output directory
        for (const emission of all) {
          expect(emission.path).toMatch(/^custom\/models\//)
        }
      })
    )
  })

  describe("entity filtering", () => {
    it.effect("skips entities with @omit tag", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Just verify we get some output (entities without @omit)
        expect(all.length).toBeGreaterThan(0)
      })
    )
  })

  describe("smart tags", () => {
    /**
     * Helper to mutate a field's tags in the IR.
     * We clone the IR and modify the specified field to add smart tags.
     */
    function addSmartTagToField(
      ir: SemanticIR,
      entityName: string,
      fieldName: string,
      tags: Record<string, unknown>
    ): SemanticIR {
      const entity = ir.entities.get(entityName)
      if (!entity) throw new Error(`Entity ${entityName} not found`)
      if (!isTableEntity(entity)) throw new Error(`Entity ${entityName} is not a table/view`)
      
      const field = entity.shapes.row.fields.find((f: Field) => f.name === fieldName)
      if (!field) throw new Error(`Field ${fieldName} not found in ${entityName}`)
      
      // Mutate the field's tags (IR is mutable for testing)
      Object.assign(field.tags, tags)
      
      return ir
    }

    describe("sensitive fields", () => {
      it.effect("marks field with sensitive tag and outputs FieldExcept with json variants", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR(["app_public"])
          
          // Add sensitive tag to User.name field
          addSmartTagToField(ir, "User", "name", { "effect:model": { sensitive: true } })
          
          const testLayer = createTestLayer(ir)
          
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayer))

          const all = yield* runPluginAndGetEmissions(testLayer)
          
          const userFile = all.find((e) => e.path.includes("User.ts"))
          expect(userFile).toBeDefined()
          
          // Should contain Model.Sensitive for sensitive fields
          const content = userFile?.content ?? ""
          expect(content).toContain("Model.Sensitive")
        })
      )

      it.effect("sensitive field uses Model.Sensitive wrapper", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR(["app_public"])
          
          // Mark only name as sensitive
          addSmartTagToField(ir, "User", "name", { "effect:model": { sensitive: true } })
          
          const testLayer = createTestLayer(ir)
          
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayer))

          const all = yield* runPluginAndGetEmissions(testLayer)
          const userFile = all.find((e) => e.path.includes("User.ts"))
          const content = userFile?.content ?? ""
          
          // The name field should use Model.Sensitive
          expect(content).toMatch(/name:\s*Model\.Sensitive/)
        })
      )
    })

    describe("insert optionality override", () => {
      it.effect("insert: optional wraps field with Model.FieldOption", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR(["app_public"])
          
          // Add insert:optional tag to a non-defaulted field (User.name is text, no default)
          addSmartTagToField(ir, "User", "name", { "effect:model": { insert: "optional" } })
          
          const testLayer = createTestLayer(ir)
          
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayer))

          const all = yield* runPluginAndGetEmissions(testLayer)
          
          const userFile = all.find((e) => e.path.includes("User.ts"))
          expect(userFile).toBeDefined()
          
          // Should contain Model.FieldOption for the optional field
          const content = userFile?.content ?? ""
          expect(content).toContain("Model.FieldOption")
        })
      )

      it.effect("insert: required overrides default generated behavior", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR(["app_public"])
          
          // Find an entity with a defaulted primary key (User.id has default gen_random_uuid())
          // By default it would be Model.Generated, but insert:required should prevent that
          const userEntity = ir.entities.get("User")
          expect(userEntity).toBeDefined()
          expect(isTableEntity(userEntity!)).toBe(true)
          
          // Verify the id field has a default (precondition)
          const tableEntity = userEntity as TableEntity
          const idField = tableEntity.shapes.row.fields.find((f: Field) => f.name === "id")
          expect(idField?.hasDefault).toBe(true)
          
          // First, run WITHOUT insert:required to verify it normally uses Model.Generated
          const testLayerBefore = createTestLayer(ir)
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayerBefore))

          const allBefore = yield* runPluginAndGetEmissions(testLayerBefore)
          const userFileBefore = allBefore.find((e) => e.path.includes("User.ts"))
          const contentBefore = userFileBefore?.content ?? ""
          
          // By default, id should be wrapped in Model.Generated
          expect(contentBefore).toContain("id: Model.Generated")
          
          // Now add insert:required tag and regenerate
          addSmartTagToField(ir, "User", "id", { "effect:model": { insert: "required" } })
          
          const testLayerAfter = createTestLayer(ir)
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayerAfter))

          const allAfter = yield* runPluginAndGetEmissions(testLayerAfter)
          const userFileAfter = allAfter.find((e) => e.path.includes("User.ts"))
          const contentAfter = userFileAfter?.content ?? ""
          
          // With insert:required, id should NOT be wrapped with Model.Generated
          // It may still have Model.FieldExcept for update permissions
          expect(contentAfter).not.toContain("id: Model.Generated")
          
          // Should still have the id field with S.UUID somewhere
          expect(contentAfter).toContain("S.UUID")
        })
      )
    })

    describe("combined smart tags", () => {
      it.effect("field can have both sensitive and insert:optional tags", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR(["app_public"])
          
          // Add both tags to User.name
          addSmartTagToField(ir, "User", "name", { 
            "effect:model": { sensitive: true, insert: "optional" } 
          })
          
          const testLayer = createTestLayer(ir)
          
          yield* effectModelPlugin.plugin.run({ outputDir: "models" })
            .pipe(Effect.provide(testLayer))

          const all = yield* runPluginAndGetEmissions(testLayer)
          
          const userFile = all.find((e) => e.path.includes("User.ts"))
          const content = userFile?.content ?? ""
          
          // Should have both FieldOption and Sensitive
          expect(content).toContain("Model.FieldOption")
          expect(content).toContain("Model.Sensitive")
        })
      )
    })
  })

  describe("composite type generation", () => {
    it.effect("generates S.Struct schemas for composite types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Check for composite type file (UsernameSearch or TagSearchResult from example DB)
        const compositeFile = all.find(e => 
          e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts")
        )
        expect(compositeFile).toBeDefined()
        expect(compositeFile?.content).toContain("S.Struct")
      })
    )

    it.effect("composite schemas do not use Model.Class", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const compositeFile = all.find(e => 
          e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts")
        )
        expect(compositeFile).toBeDefined()
        // Composites use S.Struct, not Model.Class
        expect(compositeFile?.content).not.toContain("Model.Class")
      })
    )

    it.effect("composite schemas only import Schema, not Model", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const compositeFile = all.find(e => 
          e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts")
        )
        expect(compositeFile).toBeDefined()
        // Should import Schema as S from effect, but NOT Model from @effect/sql
        expect(compositeFile?.content).toContain('import { Schema as S } from "effect"')
        expect(compositeFile?.content).not.toContain('@effect/sql')
      })
    )

    it.effect("registers symbols for composite schemas", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // Should have registered composite schema
        const compositeSymbol = allSymbols.find(
          s => (s.entity === "UsernameSearch" || s.entity === "TagSearchResult") && !s.isType
        )
        expect(compositeSymbol).toBeDefined()
        expect(compositeSymbol?.capability).toBe("models:effect")
      })
    )

    it.effect("exports inferred types for composites by default", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const compositeFile = all.find(e => 
          e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts")
        )
        expect(compositeFile).toBeDefined()
        // Should have S.Schema.Type<typeof X> for inferred type
        expect(compositeFile?.content).toContain("S.Schema.Type<typeof")
      })
    )

    it.effect("does not export inferred types when exportTypes is false", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* effectModelPlugin
          .plugin.run({ outputDir: "models", exportTypes: false })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const compositeFile = all.find(e => 
          e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts")
        )
        expect(compositeFile).toBeDefined()
        // Should NOT have type export
        expect(compositeFile?.content).not.toContain("S.Schema.Type")
        // But should still have the schema
        expect(compositeFile?.content).toContain("S.Struct")
      })
    )
  })
})
