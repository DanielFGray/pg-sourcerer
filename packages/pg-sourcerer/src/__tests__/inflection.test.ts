/**
 * Inflection Service Unit Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { 
  defaultInflection, 
  createInflection,
  inflect,
  composeInflection,
} from "../services/inflection.js"
import type { PgAttribute, PgClass, PgType } from "@danielfgray/pg-introspection"
import type { SmartTags } from "../ir/index.js"
import type { CoreInflection } from "../services/inflection.js"

// Helper to create minimal mock objects
const mockPgClass = (relname: string): PgClass =>
  ({ relname }) as unknown as PgClass

const mockPgAttribute = (attname: string): PgAttribute =>
  ({ attname }) as unknown as PgAttribute

const mockPgType = (typname: string): PgType =>
  ({ typname }) as unknown as PgType

const emptyTags: SmartTags = {}

// Identity inflection for testing composition in isolation
const identityInflection: CoreInflection = {
  camelCase: inflect.camelCase,
  pascalCase: inflect.pascalCase,
  pluralize: inflect.pluralize,
  singularize: inflect.singularize,
  safeIdentifier: (text) => text,
  entityName: (pgClass, tags) => tags.name ?? pgClass.relname,
  shapeName: (entityName, kind) => kind === "row" ? entityName : entityName + kind,
  fieldName: (pgAttribute, tags) => tags.name ?? pgAttribute.attname,
  enumName: (pgType, tags) => tags.name ?? pgType.typname,
  enumValueName: (value) => value,
  relationName: (name) => name,
  functionName: (pgProc, tags) => tags.name ?? `${pgProc.proname}_${pgProc.pronargs}`,
}

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

    it("applies default transforms (singularize + PascalCase)", () => {
      // defaultInflection now applies standard JS/TS conventions
      expect(defaultInflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(defaultInflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPost")
      expect(defaultInflection.entityName(mockPgClass("user"), emptyTags)).toBe("User")
      expect(defaultInflection.entityName(mockPgClass("categories"), emptyTags)).toBe("Category")
    })
  })

  describe("shapeName", () => {
    it("returns entity name for row, appends capitalized kind for others", () => {
      // row shape has no suffix, insert/update have Capitalized suffix
      expect(defaultInflection.shapeName("User", "row")).toBe("User")
      expect(defaultInflection.shapeName("User", "insert")).toBe("UserInsert")
      expect(defaultInflection.shapeName("User", "update")).toBe("UserUpdate")
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

    it("applies default transforms (PascalCase)", () => {
      // defaultInflection now applies standard JS/TS conventions
      expect(defaultInflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
      expect(defaultInflection.enumName(mockPgType("order_type"), emptyTags)).toBe("OrderType")
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
    it("applies default transforms (camelCase)", () => {
      // defaultInflection now applies camelCase to relation names
      expect(defaultInflection.relationName("author")).toBe("author")
      expect(defaultInflection.relationName("user_info")).toBe("userInfo")
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

  describe("with empty config", () => {
    it("behaves like defaultInflection when config is empty object", () => {
      const inflection = createInflection({})
      
      // Empty config now merges with defaults (PascalCase entities, identity fields, PascalCase enums)
      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("user_id")
      expect(inflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
    })
  })

  describe("with entityName chain", () => {
    it("applies pascalCase transform", () => {
      const inflection = createInflection({
        entityName: inflect.pascalCase,
      })

      // "users" → "Users" (pascalCase only, no singularize)
      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("Users")
      expect(inflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPosts")
    })

    it("applies singularize + pascalCase chain", () => {
      const inflection = createInflection({
        entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
      })

      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(inflection.entityName(mockPgClass("blog_posts"), emptyTags)).toBe("BlogPost")
    })

    it("smart tags still take precedence", () => {
      const inflection = createInflection({
        entityName: inflect.uppercase,
      })

      const tags: SmartTags = { name: "CustomName" }
      expect(inflection.entityName(mockPgClass("users"), tags)).toBe("CustomName")
    })
  })

  describe("with fieldName chain", () => {
    it("applies camelCase transform", () => {
      const inflection = createInflection({
        fieldName: inflect.camelCase,
      })

      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("userId")
      expect(inflection.fieldName(mockPgAttribute("created_at"), emptyTags)).toBe("createdAt")
    })

    it("undefined config fields preserve original", () => {
      const inflection = createInflection({
        entityName: inflect.pascalCase, // need at least one to avoid returning default
        // fieldName is undefined, so it should preserve original
      })

      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("user_id")
    })

    it("smart tags still take precedence", () => {
      const inflection = createInflection({
        fieldName: inflect.uppercase,
      })

      const tags: SmartTags = { name: "customField" }
      expect(inflection.fieldName(mockPgAttribute("user_id"), tags)).toBe("customField")
    })
  })

  describe("with enumName chain", () => {
    it("applies pascalCase transform", () => {
      const inflection = createInflection({
        enumName: inflect.pascalCase,
      })

      expect(inflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
    })
  })

  describe("with enumValue chain", () => {
    it("applies uppercase transform", () => {
      const inflection = createInflection({
        enumValue: inflect.uppercase,
      })

      expect(inflection.enumValueName("active")).toBe("ACTIVE")
      expect(inflection.enumValueName("pending")).toBe("PENDING")
    })

    it("applies lowercase transform", () => {
      const inflection = createInflection({
        enumValue: inflect.lowercase,
      })

      expect(inflection.enumValueName("ACTIVE")).toBe("active")
    })
  })

  describe("with shapeSuffix chain", () => {
    it("applies capitalize transform to non-row shapes only", () => {
      const inflection = createInflection({
        shapeSuffix: inflect.capitalize,
      })

      // row shape never gets suffix
      expect(inflection.shapeName("User", "row")).toBe("User")
      expect(inflection.shapeName("User", "insert")).toBe("UserInsert")
    })

    it("applies uppercase transform to non-row shapes only", () => {
      const inflection = createInflection({
        shapeSuffix: inflect.uppercase,
      })

      // row shape never gets suffix
      expect(inflection.shapeName("User", "row")).toBe("User")
      expect(inflection.shapeName("User", "insert")).toBe("UserINSERT")
    })
  })

  describe("with relationName chain", () => {
    it("applies camelCase transform", () => {
      const inflection = createInflection({
        relationName: inflect.camelCase,
      })

      // relationName is now a simple string transform
      expect(inflection.relationName("user_info")).toBe("userInfo")
      expect(inflection.relationName("author")).toBe("author")
    })
  })

  describe("with multiple chains", () => {
    it("applies all configured chains", () => {
      const inflection = createInflection({
        entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
        fieldName: inflect.camelCase,
        enumName: inflect.pascalCase,
        shapeSuffix: inflect.capitalize,
      })

      expect(inflection.entityName(mockPgClass("users"), emptyTags)).toBe("User")
      expect(inflection.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("userId")
      expect(inflection.enumName(mockPgType("user_status"), emptyTags)).toBe("UserStatus")
      // row shape never gets suffix
      expect(inflection.shapeName("User", "row")).toBe("User")
    })
  })

  describe("primitive transforms are unchanged", () => {
    it("camelCase, pascalCase, pluralize, singularize, safeIdentifier are from default", () => {
      const inflection = createInflection({
        entityName: inflect.uppercase,
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

describe("composeInflection", () => {
  describe("with undefined plugin defaults", () => {
    it("returns base inflection unchanged", () => {
      const composed = composeInflection(defaultInflection, undefined)
      expect(composed).toBe(defaultInflection)
    })
  })

  describe("with empty plugin defaults", () => {
    it("returns base inflection unchanged when all transforms are undefined", () => {
      const composed = composeInflection(defaultInflection, {})
      expect(composed).toBe(defaultInflection)
    })
  })

  describe("entityName composition", () => {
    it("applies plugin transform first, then base transform", () => {
      // Plugin: uppercase  Base: (identity)
      // "users" → "USERS" → "USERS"
      const composed = composeInflection(defaultInflection, {
        entityName: inflect.uppercase,
      })

      expect(composed.entityName(mockPgClass("users"), emptyTags)).toBe("USERS")
    })

    it("composes with base that also transforms", () => {
      // Plugin: singularize  Base: pascalCase
      // "users" → "user" → "User"
      const base = createInflection({ entityName: inflect.pascalCase })
      const composed = composeInflection(base, {
        entityName: inflect.singularize,
      })

      expect(composed.entityName(mockPgClass("users"), emptyTags)).toBe("User")
    })

    it("smart tags take precedence over composed transforms", () => {
      const composed = composeInflection(defaultInflection, {
        entityName: inflect.uppercase,
      })

      const tags: SmartTags = { name: "CustomName" }
      expect(composed.entityName(mockPgClass("users"), tags)).toBe("CustomName")
    })
  })

  describe("fieldName composition", () => {
    it("applies plugin transform first, then base transform", () => {
      // Plugin: uppercase  Base: (identity)
      const composed = composeInflection(defaultInflection, {
        fieldName: inflect.uppercase,
      })

      expect(composed.fieldName(mockPgAttribute("user_id"), emptyTags)).toBe("USER_ID")
    })

    it("composes with base that has camelCase", () => {
      // Plugin: lowercase  Base: camelCase
      // "USER_NAME" → "user_name" → "userName"
      const base = createInflection({ fieldName: inflect.camelCase })
      const composed = composeInflection(base, {
        fieldName: inflect.lowercase,
      })

      expect(composed.fieldName(mockPgAttribute("USER_NAME"), emptyTags)).toBe("userName")
    })

    it("smart tags take precedence over composed transforms", () => {
      const composed = composeInflection(defaultInflection, {
        fieldName: inflect.uppercase,
      })

      const tags: SmartTags = { name: "customField" }
      expect(composed.fieldName(mockPgAttribute("user_id"), tags)).toBe("customField")
    })
  })

  describe("enumName composition", () => {
    it("applies plugin transform first, then base transform", () => {
      // Use identity base to test plugin transform in isolation
      const composed = composeInflection(identityInflection, {
        enumName: inflect.uppercase,
      })

      expect(composed.enumName(mockPgType("user_status"), emptyTags)).toBe("USER_STATUS")
    })

    it("composes with base that has pascalCase", () => {
      // Plugin: lowercase  Base: pascalCase
      const base = createInflection({ enumName: inflect.pascalCase })
      const composed = composeInflection(base, {
        enumName: inflect.lowercase,
      })

      expect(composed.enumName(mockPgType("USER_STATUS"), emptyTags)).toBe("UserStatus")
    })

    it("smart tags take precedence over composed transforms", () => {
      const composed = composeInflection(defaultInflection, {
        enumName: inflect.uppercase,
      })

      const tags: SmartTags = { name: "CustomEnum" }
      expect(composed.enumName(mockPgType("user_status"), tags)).toBe("CustomEnum")
    })
  })

  describe("enumValue composition", () => {
    it("applies plugin transform first, then base transform", () => {
      const composed = composeInflection(defaultInflection, {
        enumValue: inflect.uppercase,
      })

      expect(composed.enumValueName("active")).toBe("ACTIVE")
    })

    it("composes with base that also transforms", () => {
      // Plugin: uppercase  Base: lowercase
      // "Active" → "ACTIVE" → "active"
      const base = createInflection({ enumValue: inflect.lowercase })
      const composed = composeInflection(base, {
        enumValue: inflect.uppercase,
      })

      expect(composed.enumValueName("Active")).toBe("active")
    })
  })

  describe("shapeSuffix composition", () => {
    it("applies plugin transform to non-row shape suffix", () => {
      const composed = composeInflection(defaultInflection, {
        shapeSuffix: inflect.uppercase,
      })

      // row shape never gets suffix
      expect(composed.shapeName("User", "row")).toBe("User")
      expect(composed.shapeName("User", "insert")).toBe("UserINSERT")
    })

    it("composes with base shapeName behavior for non-row shapes", () => {
      // Plugin: capitalize  Base: (identity)
      const composed = composeInflection(defaultInflection, {
        shapeSuffix: inflect.capitalize,
      })

      // row shape never gets suffix
      expect(composed.shapeName("User", "row")).toBe("User")
      expect(composed.shapeName("User", "insert")).toBe("UserInsert")
    })
  })

  describe("relationName composition", () => {
    it("applies plugin transform first, then base transform", () => {
      // Use identity base to test plugin transform in isolation
      const composed = composeInflection(identityInflection, {
        relationName: inflect.uppercase,
      })

      // relationName is now a simple string transform
      expect(composed.relationName("author")).toBe("AUTHOR")
      expect(composed.relationName("user_info")).toBe("USER_INFO")
    })

    it("composes with base that has camelCase", () => {
      const base = createInflection({ relationName: inflect.camelCase })
      const composed = composeInflection(base, {
        relationName: inflect.lowercase,
      })

      // plugin (lowercase) runs first, then base (camelCase)
      // "USER_INFO" → lowercase → "user_info" → camelCase → "userInfo"
      expect(composed.relationName("USER_INFO")).toBe("userInfo")
      expect(composed.relationName("user_info")).toBe("userInfo")
    })
  })

  describe("primitive transforms are unchanged", () => {
    it("camelCase, pascalCase, etc. come from base inflection", () => {
      const composed = composeInflection(defaultInflection, {
        entityName: inflect.uppercase,
      })

      // These should still work normally (not affected by composition)
      expect(composed.camelCase("user_name")).toBe("userName")
      expect(composed.pascalCase("user_name")).toBe("UserName")
      expect(composed.pluralize("user")).toBe("users")
      expect(composed.singularize("users")).toBe("user")
      expect(composed.safeIdentifier("class")).toBe("class_")
    })
  })

  describe("multiple transforms composed together", () => {
    it("applies all plugin defaults correctly", () => {
      const base = createInflection({
        entityName: inflect.pascalCase,
        fieldName: inflect.camelCase,
        enumName: inflect.pascalCase,
        shapeSuffix: inflect.capitalize,
      })

      const composed = composeInflection(base, {
        entityName: inflect.singularize,
        fieldName: inflect.lowercase, // will be lowercased then camelCased
        enumName: inflect.lowercase,
        shapeSuffix: inflect.uppercase,
      })

      // entities: "users" → singularize → "user" → pascalCase → "User"
      expect(composed.entityName(mockPgClass("users"), emptyTags)).toBe("User")

      // fields: "USER_NAME" → lowercase → "user_name" → camelCase → "userName"
      expect(composed.fieldName(mockPgAttribute("USER_NAME"), emptyTags)).toBe("userName")

      // enums: "USER_STATUS" → lowercase → "user_status" → pascalCase → "UserStatus"
      expect(composed.enumName(mockPgType("USER_STATUS"), emptyTags)).toBe("UserStatus")

      // shapes: row never gets suffix, insert gets uppercase suffix
      expect(composed.shapeName("User", "row")).toBe("User")
      expect(composed.shapeName("User", "insert")).toBe("UserINSERT")
    })
  })
})
