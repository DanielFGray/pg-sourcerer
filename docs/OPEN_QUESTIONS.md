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

## Needs User Input

### Default Query Generation Strategy

**Question**: How aggressive should query ideation be by default?

**Options**:

A) **Conservative**: Only PK lookups + basic CRUD. User opts into more.

B) **Moderate**: PK + unique indexes + obvious relations. Skip ambiguous cases.
   
C) **Aggressive**: Generate everything indexes suggest. User prunes.

**Status**: Needs user feedback. Different users have different preferences. Possibly a config option.
