/**
 * Inflection Service Unit Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { liveInflection } from "../services/inflection.js"
import type { PgAttribute, PgClass, PgConstraint, PgType } from "pg-introspection"
import type { SmartTags } from "../ir/index.js"

// Helper to create minimal mock objects
const mockPgClass = (relname: string): PgClass =>
  ({ relname }) as unknown as PgClass

const mockPgAttribute = (attname: string): PgAttribute =>
  ({ attname }) as unknown as PgAttribute

const mockPgType = (typname: string): PgType =>
  ({ typname }) as unknown as PgType

const mockPgConstraint = (conname: string): PgConstraint =>
  ({ conname }) as unknown as PgConstraint

const emptyTags: SmartTags = {}

describe("Inflection Service", () => {
  describe("camelCase", () => {
    it("converts snake_case to camelCase", () => {
      expect(liveInflection.camelCase("user_name")).toBe("userName")
      expect(liveInflection.camelCase("created_at")).toBe("createdAt")
      expect(liveInflection.camelCase("foo_bar_baz")).toBe("fooBarBaz")
    })

    it("handles single words", () => {
      expect(liveInflection.camelCase("user")).toBe("user")
      expect(liveInflection.camelCase("id")).toBe("id")
    })

    it("handles snake_case with numbers", () => {
      expect(liveInflection.camelCase("user_v2")).toBe("userV2")
      expect(liveInflection.camelCase("api_v2_endpoint")).toBe("apiV2Endpoint")
    })

    it("handles already camelCase input", () => {
      // Effect's snakeToCamel only transforms underscores
      expect(liveInflection.camelCase("userName")).toBe("userName")
    })

    it("preserves leading underscores", () => {
      // Effect's snakeToCamel preserves single leading underscore
      expect(liveInflection.camelCase("_private")).toBe("_private")
      // Double underscore: first preserved, second treated as separator
      expect(liveInflection.camelCase("__double")).toBe("_Double")
    })

    it("handles consecutive underscores (preserves one)", () => {
      // Effect's snakeToCamel treats double underscore specially
      expect(liveInflection.camelCase("foo__bar")).toBe("foo_bar")
    })
  })

  describe("pascalCase", () => {
    it("converts snake_case to PascalCase", () => {
      expect(liveInflection.pascalCase("user_name")).toBe("UserName")
      expect(liveInflection.pascalCase("created_at")).toBe("CreatedAt")
    })

    it("handles single words", () => {
      expect(liveInflection.pascalCase("user")).toBe("User")
      expect(liveInflection.pascalCase("id")).toBe("Id")
    })

    it("handles snake_case with numbers", () => {
      expect(liveInflection.pascalCase("user_v2")).toBe("UserV2")
    })
  })

  describe("pluralize", () => {
    it("adds 's' to regular words", () => {
      expect(liveInflection.pluralize("user")).toBe("users")
      expect(liveInflection.pluralize("post")).toBe("posts")
      expect(liveInflection.pluralize("tag")).toBe("tags")
    })

    it("adds 'es' to words ending in s, x, z, ch, sh", () => {
      expect(liveInflection.pluralize("bus")).toBe("buses")
      expect(liveInflection.pluralize("box")).toBe("boxes")
      expect(liveInflection.pluralize("quiz")).toBe("quizes") // naive impl doesn't double z
      expect(liveInflection.pluralize("watch")).toBe("watches")
      expect(liveInflection.pluralize("dish")).toBe("dishes")
    })

    it("handles words ending in consonant + y", () => {
      expect(liveInflection.pluralize("city")).toBe("cities")
      expect(liveInflection.pluralize("category")).toBe("categories")
    })

    it("handles words ending in vowel + y", () => {
      expect(liveInflection.pluralize("day")).toBe("days")
      expect(liveInflection.pluralize("key")).toBe("keys")
    })

    // Note: naive implementation - doesn't handle irregular plurals
    it("handles regular words (naive - no irregular support)", () => {
      // person -> persons (not people)
      expect(liveInflection.pluralize("person")).toBe("persons")
      // child -> childs (not children)
      expect(liveInflection.pluralize("child")).toBe("childs")
    })
  })

  describe("singularize", () => {
    it("removes 's' from regular plurals", () => {
      expect(liveInflection.singularize("users")).toBe("user")
      expect(liveInflection.singularize("posts")).toBe("post")
    })

    it("handles 'ies' -> 'y'", () => {
      expect(liveInflection.singularize("cities")).toBe("city")
      expect(liveInflection.singularize("categories")).toBe("category")
    })

    it("handles 'sses' -> 'ss'", () => {
      expect(liveInflection.singularize("classes")).toBe("class")
      expect(liveInflection.singularize("passes")).toBe("pass")
    })

    it("handles 'xes' -> 'x'", () => {
      expect(liveInflection.singularize("boxes")).toBe("box")
    })

    it("handles 'ches' -> 'ch'", () => {
      expect(liveInflection.singularize("watches")).toBe("watch")
    })

    it("handles 'shes' -> 'sh'", () => {
      expect(liveInflection.singularize("dishes")).toBe("dish")
    })

    it("does not remove 's' from words ending in 'ss'", () => {
      expect(liveInflection.singularize("class")).toBe("class")
      expect(liveInflection.singularize("boss")).toBe("boss")
    })

    it("handles single character words", () => {
      expect(liveInflection.singularize("s")).toBe("s")
    })
  })

  describe("safeIdentifier", () => {
    it("appends underscore to reserved words", () => {
      expect(liveInflection.safeIdentifier("class")).toBe("class_")
      expect(liveInflection.safeIdentifier("type")).toBe("type_")
      expect(liveInflection.safeIdentifier("default")).toBe("default_")
      expect(liveInflection.safeIdentifier("enum")).toBe("enum_")
      expect(liveInflection.safeIdentifier("function")).toBe("function_")
    })

    it("leaves non-reserved words unchanged", () => {
      expect(liveInflection.safeIdentifier("user")).toBe("user")
      expect(liveInflection.safeIdentifier("name")).toBe("name")
      expect(liveInflection.safeIdentifier("myClass")).toBe("myClass")
    })

    it("handles TypeScript-specific reserved words", () => {
      expect(liveInflection.safeIdentifier("readonly")).toBe("readonly_")
      expect(liveInflection.safeIdentifier("keyof")).toBe("keyof_")
      expect(liveInflection.safeIdentifier("infer")).toBe("infer_")
    })

    it("handles primitive type names", () => {
      expect(liveInflection.safeIdentifier("string")).toBe("string_")
      expect(liveInflection.safeIdentifier("number")).toBe("number_")
      expect(liveInflection.safeIdentifier("boolean")).toBe("boolean_")
      expect(liveInflection.safeIdentifier("object")).toBe("object_")
      expect(liveInflection.safeIdentifier("symbol")).toBe("symbol_")
      expect(liveInflection.safeIdentifier("bigint")).toBe("bigint_")
    })
  })

  describe("entityName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "CustomName" }
      expect(liveInflection.entityName(mockPgClass("users"), tags)).toBe("CustomName")
    })

    it("singularizes and PascalCases table name", () => {
      expect(liveInflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(liveInflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPost")
    })

    it("handles already singular names", () => {
      expect(liveInflection.entityName(mockPgClass("user"), emptyTags)).toBe("User")
    })

    it("handles complex plurals", () => {
      expect(liveInflection.entityName(mockPgClass("categories"), emptyTags)).toBe("Category")
      expect(liveInflection.entityName(mockPgClass("companies"), emptyTags)).toBe("Company")
    })
  })

  describe("shapeName", () => {
    it("appends capitalized kind to entity name", () => {
      expect(liveInflection.shapeName("User", "row")).toBe("UserRow")
      expect(liveInflection.shapeName("User", "insert")).toBe("UserInsert")
      expect(liveInflection.shapeName("User", "update")).toBe("UserUpdate")
      expect(liveInflection.shapeName("User", "patch")).toBe("UserPatch")
    })
  })

  describe("fieldName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "customField" }
      expect(liveInflection.fieldName(mockPgAttribute("user_id"), tags)).toBe("customField")
    })

    it("converts snake_case column to camelCase", () => {
      expect(liveInflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("userId")
      expect(liveInflection.fieldName(mockPgAttribute("created_at"), emptyTags)).toBe("createdAt")
    })

    it("handles single word columns", () => {
      expect(liveInflection.fieldName(mockPgAttribute("id"), emptyTags)).toBe("id")
      expect(liveInflection.fieldName(mockPgAttribute("name"), emptyTags)).toBe("name")
    })
  })

  describe("enumName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "CustomEnum" }
      expect(liveInflection.enumName(mockPgType("user_status"), tags)).toBe("CustomEnum")
    })

    it("converts snake_case to PascalCase", () => {
      expect(liveInflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
      expect(liveInflection.enumName(mockPgType("order_type"), emptyTags)).toBe("OrderType")
    })
  })

  describe("enumValueName", () => {
    it("preserves original value", () => {
      expect(liveInflection.enumValueName("ACTIVE")).toBe("ACTIVE")
      expect(liveInflection.enumValueName("pending")).toBe("pending")
      expect(liveInflection.enumValueName("in_progress")).toBe("in_progress")
    })
  })

  describe("relationName", () => {
    it("uses @fieldName tag for local side", () => {
      const tags: SmartTags = { fieldName: "author" }
      expect(liveInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "local", tags))
        .toBe("author")
    })

    it("uses @foreignFieldName tag for foreign side", () => {
      const tags: SmartTags = { foreignFieldName: "posts" }
      expect(liveInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "foreign", tags))
        .toBe("posts")
    })

    it("derives name from constraint when no tags", () => {
      // "posts_author_id_fkey" -> remove _fkey -> "posts_author_id" 
      // -> remove _id -> "posts_author" -> remove table prefix -> "author"
      expect(liveInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "local", emptyTags))
        .toBe("author")
    })

    it("handles various constraint naming patterns", () => {
      expect(liveInflection.relationName(mockPgConstraint("comments_user_id_fkey"), "local", emptyTags))
        .toBe("user")
      
      // Multi-word table prefix: only first segment is stripped
      // "order_items_product_id_fkey" -> "items_product" (after removing order_ prefix and _id_fkey suffix)
      expect(liveInflection.relationName(mockPgConstraint("order_items_product_id_fkey"), "local", emptyTags))
        .toBe("itemsProduct")
    })

    it("handles constraint without _id suffix", () => {
      expect(liveInflection.relationName(mockPgConstraint("posts_category_fkey"), "local", emptyTags))
        .toBe("category")
    })
  })
})
