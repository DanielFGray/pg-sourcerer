/**
 * Inflection Service Unit Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { 
  defaultInflection, 
  createInflection,
  applyTransformChain,
  type TransformChain,
} from "../services/inflection.js"
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
      expect(defaultInflection.camelCase("user_name")).toBe("userName")
      expect(defaultInflection.camelCase("created_at")).toBe("createdAt")
      expect(defaultInflection.camelCase("foo_bar_baz")).toBe("fooBarBaz")
    })

    it("handles single words", () => {
      expect(defaultInflection.camelCase("user")).toBe("user")
      expect(defaultInflection.camelCase("id")).toBe("id")
    })

    it("handles snake_case with numbers", () => {
      expect(defaultInflection.camelCase("user_v2")).toBe("userV2")
      expect(defaultInflection.camelCase("api_v2_endpoint")).toBe("apiV2Endpoint")
    })

    it("handles already camelCase input", () => {
      // Effect's snakeToCamel only transforms underscores
      expect(defaultInflection.camelCase("userName")).toBe("userName")
    })

    it("preserves leading underscores", () => {
      // Effect's snakeToCamel preserves single leading underscore
      expect(defaultInflection.camelCase("_private")).toBe("_private")
      // Double underscore: first preserved, second treated as separator
      expect(defaultInflection.camelCase("__double")).toBe("_Double")
    })

    it("handles consecutive underscores (preserves one)", () => {
      // Effect's snakeToCamel treats double underscore specially
      expect(defaultInflection.camelCase("foo__bar")).toBe("foo_bar")
    })
  })

  describe("pascalCase", () => {
    it("converts snake_case to PascalCase", () => {
      expect(defaultInflection.pascalCase("user_name")).toBe("UserName")
      expect(defaultInflection.pascalCase("created_at")).toBe("CreatedAt")
    })

    it("handles single words", () => {
      expect(defaultInflection.pascalCase("user")).toBe("User")
      expect(defaultInflection.pascalCase("id")).toBe("Id")
    })

    it("handles snake_case with numbers", () => {
      expect(defaultInflection.pascalCase("user_v2")).toBe("UserV2")
    })
  })

  describe("pluralize", () => {
    it("adds 's' to regular words", () => {
      expect(defaultInflection.pluralize("user")).toBe("users")
      expect(defaultInflection.pluralize("post")).toBe("posts")
      expect(defaultInflection.pluralize("tag")).toBe("tags")
    })

    it("adds 'es' to words ending in s, x, z, ch, sh", () => {
      expect(defaultInflection.pluralize("bus")).toBe("buses")
      expect(defaultInflection.pluralize("box")).toBe("boxes")
      expect(defaultInflection.pluralize("quiz")).toBe("quizes") // naive impl doesn't double z
      expect(defaultInflection.pluralize("watch")).toBe("watches")
      expect(defaultInflection.pluralize("dish")).toBe("dishes")
    })

    it("handles words ending in consonant + y", () => {
      expect(defaultInflection.pluralize("city")).toBe("cities")
      expect(defaultInflection.pluralize("category")).toBe("categories")
    })

    it("handles words ending in vowel + y", () => {
      expect(defaultInflection.pluralize("day")).toBe("days")
      expect(defaultInflection.pluralize("key")).toBe("keys")
    })

    // Note: naive implementation - doesn't handle irregular plurals
    it("handles regular words (naive - no irregular support)", () => {
      // person -> persons (not people)
      expect(defaultInflection.pluralize("person")).toBe("persons")
      // child -> childs (not children)
      expect(defaultInflection.pluralize("child")).toBe("childs")
    })
  })

  describe("singularize", () => {
    it("removes 's' from regular plurals", () => {
      expect(defaultInflection.singularize("users")).toBe("user")
      expect(defaultInflection.singularize("posts")).toBe("post")
    })

    it("handles 'ies' -> 'y'", () => {
      expect(defaultInflection.singularize("cities")).toBe("city")
      expect(defaultInflection.singularize("categories")).toBe("category")
    })

    it("handles 'sses' -> 'ss'", () => {
      expect(defaultInflection.singularize("classes")).toBe("class")
      expect(defaultInflection.singularize("passes")).toBe("pass")
    })

    it("handles 'xes' -> 'x'", () => {
      expect(defaultInflection.singularize("boxes")).toBe("box")
    })

    it("handles 'ches' -> 'ch'", () => {
      expect(defaultInflection.singularize("watches")).toBe("watch")
    })

    it("handles 'shes' -> 'sh'", () => {
      expect(defaultInflection.singularize("dishes")).toBe("dish")
    })

    it("does not remove 's' from words ending in 'ss'", () => {
      expect(defaultInflection.singularize("class")).toBe("class")
      expect(defaultInflection.singularize("boss")).toBe("boss")
    })

    it("handles single character words", () => {
      expect(defaultInflection.singularize("s")).toBe("s")
    })
  })

  describe("safeIdentifier", () => {
    it("appends underscore to reserved words", () => {
      expect(defaultInflection.safeIdentifier("class")).toBe("class_")
      expect(defaultInflection.safeIdentifier("type")).toBe("type_")
      expect(defaultInflection.safeIdentifier("default")).toBe("default_")
      expect(defaultInflection.safeIdentifier("enum")).toBe("enum_")
      expect(defaultInflection.safeIdentifier("function")).toBe("function_")
    })

    it("leaves non-reserved words unchanged", () => {
      expect(defaultInflection.safeIdentifier("user")).toBe("user")
      expect(defaultInflection.safeIdentifier("name")).toBe("name")
      expect(defaultInflection.safeIdentifier("myClass")).toBe("myClass")
    })

    it("handles TypeScript-specific reserved words", () => {
      expect(defaultInflection.safeIdentifier("readonly")).toBe("readonly_")
      expect(defaultInflection.safeIdentifier("keyof")).toBe("keyof_")
      expect(defaultInflection.safeIdentifier("infer")).toBe("infer_")
    })

    it("handles primitive type names", () => {
      expect(defaultInflection.safeIdentifier("string")).toBe("string_")
      expect(defaultInflection.safeIdentifier("number")).toBe("number_")
      expect(defaultInflection.safeIdentifier("boolean")).toBe("boolean_")
      expect(defaultInflection.safeIdentifier("object")).toBe("object_")
      expect(defaultInflection.safeIdentifier("symbol")).toBe("symbol_")
      expect(defaultInflection.safeIdentifier("bigint")).toBe("bigint_")
    })
  })

  describe("entityName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "CustomName" }
      expect(defaultInflection.entityName(mockPgClass("users"), tags)).toBe("CustomName")
    })

    it("returns table name unchanged (identity - no transforms)", () => {
      // defaultInflection applies no transforms - use createInflection for transforms
      expect(defaultInflection.entityName(mockPgClass("users"), emptyTags)).toBe("users")
      expect(defaultInflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("blog_posts")
      expect(defaultInflection.entityName(mockPgClass("user"), emptyTags)).toBe("user")
      expect(defaultInflection.entityName(mockPgClass("categories"), emptyTags)).toBe("categories")
    })
  })

  describe("shapeName", () => {
    it("appends kind unchanged to entity name (identity - no transforms)", () => {
      // defaultInflection applies no transforms to shapeSuffix
      expect(defaultInflection.shapeName("User", "row")).toBe("Userrow")
      expect(defaultInflection.shapeName("User", "insert")).toBe("Userinsert")
      expect(defaultInflection.shapeName("User", "update")).toBe("Userupdate")
      expect(defaultInflection.shapeName("User", "patch")).toBe("Userpatch")
    })
  })

  describe("fieldName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "customField" }
      expect(defaultInflection.fieldName(mockPgAttribute("user_id"), tags)).toBe("customField")
    })

    it("returns column name unchanged (identity - no transforms)", () => {
      // defaultInflection applies no transforms - use createInflection for transforms
      expect(defaultInflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("user_id")
      expect(defaultInflection.fieldName(mockPgAttribute("created_at"), emptyTags)).toBe("created_at")
      expect(defaultInflection.fieldName(mockPgAttribute("id"), emptyTags)).toBe("id")
      expect(defaultInflection.fieldName(mockPgAttribute("name"), emptyTags)).toBe("name")
    })
  })

  describe("enumName", () => {
    it("uses @name tag if present", () => {
      const tags: SmartTags = { name: "CustomEnum" }
      expect(defaultInflection.enumName(mockPgType("user_status"), tags)).toBe("CustomEnum")
    })

    it("returns type name unchanged (identity - no transforms)", () => {
      // defaultInflection applies no transforms - use createInflection for transforms
      expect(defaultInflection.enumName(mockPgType("user_status"), emptyTags)).toBe("user_status")
      expect(defaultInflection.enumName(mockPgType("order_type"), emptyTags)).toBe("order_type")
    })
  })

  describe("enumValueName", () => {
    it("preserves original value", () => {
      expect(defaultInflection.enumValueName("ACTIVE")).toBe("ACTIVE")
      expect(defaultInflection.enumValueName("pending")).toBe("pending")
      expect(defaultInflection.enumValueName("in_progress")).toBe("in_progress")
    })
  })

  describe("relationName", () => {
    it("uses @fieldName tag for local side", () => {
      const tags: SmartTags = { fieldName: "author" }
      expect(defaultInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "local", tags))
        .toBe("author")
    })

    it("uses @foreignFieldName tag for foreign side", () => {
      const tags: SmartTags = { foreignFieldName: "posts" }
      expect(defaultInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "foreign", tags))
        .toBe("posts")
    })

    it("derives name from constraint when no tags (identity - no transforms)", () => {
      // "posts_author_id_fkey" -> remove _fkey -> "posts_author_id" 
      // -> remove _id -> "posts_author" -> remove table prefix -> "author"
      // No additional transforms applied by defaultInflection
      expect(defaultInflection.relationName(mockPgConstraint("posts_author_id_fkey"), "local", emptyTags))
        .toBe("author")
    })

    it("handles various constraint naming patterns (identity - no transforms)", () => {
      expect(defaultInflection.relationName(mockPgConstraint("comments_user_id_fkey"), "local", emptyTags))
        .toBe("user")
      
      // Multi-word table prefix: only first segment is stripped
      // "order_items_product_id_fkey" -> "items_product" (after removing order_ prefix and _id_fkey suffix)
      // No transforms applied, so underscore preserved
      expect(defaultInflection.relationName(mockPgConstraint("order_items_product_id_fkey"), "local", emptyTags))
        .toBe("items_product")
    })

    it("handles constraint without _id suffix", () => {
      expect(defaultInflection.relationName(mockPgConstraint("posts_category_fkey"), "local", emptyTags))
        .toBe("category")
    })
  })
})

describe("createInflection", () => {
  describe("with no config", () => {
    it("returns defaultInflection", () => {
      const inflection = createInflection()
      expect(inflection).toBe(defaultInflection)
    })
  })

  describe("with empty chains", () => {
    it("returns defaultInflection when all chains empty", () => {
      const inflection = createInflection({
        entityName: [],
        fieldName: [],
      })
      expect(inflection).toBe(defaultInflection)
    })
  })

  describe("with entityName chain", () => {
    it("applies pascalCase transform", () => {
      const inflection = createInflection({
        entityName: ["pascalCase"],
      })

      // "users" → "Users" (pascalCase only, no singularize)
      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("Users")
      expect(inflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPosts")
    })

    it("applies singularize + pascalCase chain", () => {
      const inflection = createInflection({
        entityName: ["singularize", "pascalCase"],
      })

      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(inflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPost")
    })

    it("smart tags still take precedence", () => {
      const inflection = createInflection({
        entityName: ["uppercase"],
      })

      const tags: SmartTags = { name: "CustomName" }
      expect(inflection.entityName(mockPgClass("users"), tags)).toBe("CustomName")
    })
  })

  describe("with fieldName chain", () => {
    it("applies camelCase transform", () => {
      const inflection = createInflection({
        fieldName: ["camelCase"],
      })

      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("userId")
      expect(inflection.fieldName(mockPgAttribute("created_at"), emptyTags)).toBe("createdAt")
    })

    it("empty chain preserves original", () => {
      const inflection = createInflection({
        fieldName: [],
        entityName: ["pascalCase"], // need at least one non-empty to avoid returning default
      })

      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("user_id")
    })

    it("smart tags still take precedence", () => {
      const inflection = createInflection({
        fieldName: ["uppercase"],
      })

      const tags: SmartTags = { name: "customField" }
      expect(inflection.fieldName(mockPgAttribute("user_id"), tags)).toBe("customField")
    })
  })

  describe("with enumName chain", () => {
    it("applies pascalCase transform", () => {
      const inflection = createInflection({
        enumName: ["pascalCase"],
      })

      expect(inflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
    })
  })

  describe("with enumValue chain", () => {
    it("applies uppercase transform", () => {
      const inflection = createInflection({
        enumValue: ["uppercase"],
      })

      expect(inflection.enumValueName("active")).toBe("ACTIVE")
      expect(inflection.enumValueName("pending")).toBe("PENDING")
    })

    it("applies lowercase transform", () => {
      const inflection = createInflection({
        enumValue: ["lowercase"],
      })

      expect(inflection.enumValueName("ACTIVE")).toBe("active")
    })
  })

  describe("with shapeSuffix chain", () => {
    it("applies capitalize transform", () => {
      const inflection = createInflection({
        shapeSuffix: ["capitalize"],
      })

      expect(inflection.shapeName("User", "row")).toBe("UserRow")
      expect(inflection.shapeName("User", "insert")).toBe("UserInsert")
    })

    it("applies uppercase transform", () => {
      const inflection = createInflection({
        shapeSuffix: ["uppercase"],
      })

      expect(inflection.shapeName("User", "row")).toBe("UserROW")
      expect(inflection.shapeName("User", "insert")).toBe("UserINSERT")
    })
  })

  describe("with relationName chain", () => {
    it("applies camelCase transform", () => {
      const inflection = createInflection({
        relationName: ["camelCase"],
      })

      // After cleaning: "posts_author_id_fkey" → "author" → "author" (already camel)
      expect(inflection.relationName(mockPgConstraint("posts_author_id_fkey"), "local", emptyTags))
        .toBe("author")
    })
  })

  describe("with multiple chains", () => {
    it("applies all configured chains", () => {
      const inflection = createInflection({
        entityName: ["singularize", "pascalCase"],
        fieldName: ["camelCase"],
        enumName: ["pascalCase"],
        shapeSuffix: ["capitalize"],
      })

      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("userId")
      expect(inflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
      expect(inflection.shapeName("User", "row")).toBe("UserRow")
    })
  })

  describe("primitive transforms are unchanged", () => {
    it("camelCase, pascalCase, pluralize, singularize, safeIdentifier are from default", () => {
      const inflection = createInflection({
        entityName: ["uppercase"],
      })

      // These should still work normally
      expect(inflection.camelCase("user_name")).toBe("userName")
      expect(inflection.pascalCase("user_name")).toBe("UserName")
      expect(inflection.pluralize("user")).toBe("users")
      expect(inflection.singularize("users")).toBe("user")
      expect(inflection.safeIdentifier("class")).toBe("class_")
    })
  })
})

describe("applyTransformChain", () => {
  it("returns input unchanged for empty chain", () => {
    expect(applyTransformChain("hello", [])).toBe("hello")
  })

  it("applies single transform", () => {
    expect(applyTransformChain("user_name", ["camelCase"])).toBe("userName")
    expect(applyTransformChain("user_name", ["pascalCase"])).toBe("UserName")
    expect(applyTransformChain("hello", ["uppercase"])).toBe("HELLO")
  })

  it("applies transforms in order", () => {
    // singularize first, then pascalCase
    expect(applyTransformChain("users", ["singularize", "pascalCase"])).toBe("User")
    
    // pascalCase first, then... (order matters)
    expect(applyTransformChain("user_name", ["pascalCase", "uppercase"])).toBe("USERNAME")
  })

  it("supports all transform names", () => {
    expect(applyTransformChain("user_name", ["camelCase"])).toBe("userName")
    expect(applyTransformChain("user_name", ["pascalCase"])).toBe("UserName")
    expect(applyTransformChain("userName", ["snakeCase"])).toBe("user_name")
    expect(applyTransformChain("users", ["singularize"])).toBe("user")
    expect(applyTransformChain("user", ["pluralize"])).toBe("users")
    expect(applyTransformChain("hello", ["capitalize"])).toBe("Hello")
    expect(applyTransformChain("Hello", ["uncapitalize"])).toBe("hello")
    expect(applyTransformChain("Hello", ["lowercase"])).toBe("hello")
    expect(applyTransformChain("hello", ["uppercase"])).toBe("HELLO")
  })
})
