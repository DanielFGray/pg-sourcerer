# Open Questions

Genuinely unresolved items that need implementation experience or explicit decisions.

See also: [DECISIONS.md](./DECISIONS.md) for resolved questions.

## Deferred (Not Blocking)

### Incremental Regeneration

**Question**: Can we re-run only affected plugins when schema changes?

**Context**: Symbol identity + file assignments provide the foundation. A plugin's output depends on:
- IR (schema changes)
- Config (user preferences)
- Upstream plugin output (capability dependencies)

**Status**: Deferred until performance becomes a concern. Full regeneration is fast enough for now.

**When to revisit**: Large schemas (100+ tables) or slow plugins make regeneration painful.

---

### Non-SQL Data Sources

**Question**: How do OpenAPI, GraphQL, or DynamoDB fit the model?

**Context**: The `entity.kind` field can be extended (`"endpoint"`, `"graphql-type"`). Capabilities like `introspection:endpoints` would replace SQL-focused ones. See DATA_SOURCE_AGNOSTICISM.md.

**Status**: Deferred. Focus on SQL dialects (Postgres → MySQL → SQLite) first.

**When to revisit**: User demand for non-SQL sources, or a clear use case emerges.

---

## Needs Implementation Experience

### QueryIdea Field Completeness

**Question**: Does QueryIdea capture enough intent for query materialization?

**Note**: HTTP plugins don't read QueryIdea directly—they consume query function symbols via SignatureDef. QueryIdea is internal to the ideation → query pipeline.

**Current fields**:
```typescript
interface QueryIdea {
  entity: string
  operation: "findOne" | "findMany" | "create" | "update" | "delete" | "custom"
  lookupFields?: string[]
  includeRelations?: string[]
  pagination?: boolean
  rlsContext?: string
  rationale?: string
}
```

**Potential gaps**:
- Sorting preferences (`orderBy`)?
- Soft delete awareness?
- Audit field handling (createdAt, updatedAt)?

**Status**: Implement query materialization plugin. Discover what's missing when converting ideas → SignatureDef.

---

### SignatureDef Completeness

**Question**: Does SignatureDef capture enough for downstream plugins?

**Context**: SignatureDef is the interface between query plugins and HTTP/schema plugins. It references shapes by name.

```typescript
interface SignatureDef {
  params: ParamDef[]      // { name, shape: "User:insert", required }
  returns: ReturnDef      // { shape: "User:row", mode: "one" | "many" | ... }
}
```

**Potential gaps**:
- Does it need operation type (CRUD) for HTTP method mapping?
- Does it need entity name for route grouping?
- Should params distinguish path vs query vs body?

**Status**: Implement HTTP plugin. Discover what's missing when mapping SignatureDef → routes.

---

### consume() Callback Shape

**Question**: What's the exact signature of the consumer callback on schema symbols?

**Current sketch**:
```typescript
interface SchemaSymbolHandle extends SymbolHandle {
  // Given untrusted input, return validated output expression
  consume(input: Expression): Expression
}
```

**Open sub-questions**:
- Does it need async support (for Effect Schema's decode)?
- Should it return `{ expr, errorHandling }` for try/catch wrapping?
- Does it need the target context (sync handler vs async handler)?

**Status**: Implement Zod and Effect Schema plugins. Compare what they need to expose.

---

### Symbol Handle Ergonomics

**Question**: Is `.ref()` / `.typeRef()` / `.call()` / `.consume()` the right API?

**Current design**:
```typescript
const userType = registry.get({ name: "User", capability: "types" })
userType.ref()      // Identifier AST, tracks import
userType.typeRef()  // Type reference AST, tracks import
userType.call(args) // Call expression AST, tracks import

const schema = registry.get({ name: "User:insert", capability: "schemas:zod" })
schema.consume(inputExpr)  // Validation expression AST
```

**Potential issues**:
- Verbose for common cases?
- Should there be shorthand for "get and immediately ref"?
- How do type-only imports differ from value imports?

**Status**: Migrate existing plugins. Ergonomics will become clear.

---

## Needs User Input

### Smart Tag Syntax for Custom Queries

**Question**: How should users declare custom queries via smart tags?

**Options**:

A) Function-like syntax:
```sql
COMMENT ON TABLE users IS '@query findActiveByRegion(region: text) -> User[]';
```

B) Structured tags:
```sql
COMMENT ON TABLE users IS E'@query name=findActiveByRegion\n@param region text\n@returns User[]';
```

C) Reference external file:
```sql
COMMENT ON TABLE users IS '@queries ./users.queries.ts';
```

**Status**: Needs user feedback on which feels natural. Current smart tag parser may constrain options.

---

### Default Query Generation Strategy

**Question**: How aggressive should query ideation be by default?

**Options**:

A) **Conservative**: Only PK lookups + basic CRUD. User opts into more.

B) **Moderate**: PK + unique indexes + obvious relations. Skip ambiguous cases.
   
C) **Aggressive**: Generate everything indexes suggest. User prunes.

**Status**: Needs user feedback. Different users have different preferences. Possibly a config option.
