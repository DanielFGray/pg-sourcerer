# Agent Notes for pg-sourcerer

## Tooling notes
* This is a bun project. Never use `npm` or `npx` - use `bun` or `bunx`
* `ast-grep` should be used for all code editing. Execute `curl https://ast-grep.github.io/llms.txt` for more information
  * store common patterns here in this level next time you use it

## Project Overview
A PostgreSQL code generator that introspects database schemas and generates TypeScript types, Zod schemas, query builders, and HTTP endpoints. Built with Bun, uses `pg-introspection` for database analysis.

## Core Architecture

### Entry Point (`packages/pg-sourcerer/index.mjs`)
- Main CLI tool using Node.js `parseArgs` for command line parsing
- Loads config via `lilconfig`, processes plugins, and orchestrates code generation

### Database Introspection (`packages/pg-sourcerer/introspection.mjs`)
- Uses `pg-introspection` library to analyze database structure
- Transforms raw introspection into structured data for plugins

### Plugin System
Four main plugins in `packages/pg-sourcerer/plugins/`:

1. **types.mjs** - Generates TypeScript type definitions
2. **schemas.mjs** - Generates Zod validation schemas
3. **queries.mjs** - Generates query builder functions
4. **http.mjs** - Generates HTTP endpoint handlers

### Utils (`packages/pg-sourcerer/utils/index.mjs`)
- Shared utilities for AST generation, type mapping, and code generation
- Uses `recast` for AST manipulation
- Provides PostgreSQL to TypeScript type mapping

## Configuration Structure

### Main Config (`pgsourcerer.config.mjs`)
```javascript
export default defineConfig({
  connectionString: "...",
  schemas: ["app_public", "app_private"],
  plugins: [
    ...plugins
  ]
})
```

## Development Workflow

### Running Development Mode
```bash
bun dev  # Runs example with file watching
```

### Project Structure
```
packages/
  pg-sourcerer/          # Core library
    plugins/             # Code generation plugins
    utils/              # Shared utilities
    index.mjs           # CLI entry point
    introspection.mjs   # Database analysis
  example/              # Demo project
    migrations/         # Database migrations
    generated/          # Generated TypeScript files
```

## Potential Improvements

### 1. Configuration Validation
- Add Zod schema validation for configuration objects
- Better error messages for missing required fields
- Validate plugin compatibility with selected adapter

### 2. Error Handling
- Wrap database connection errors with helpful context
- Provide migration suggestions for configuration changes
- Add retry logic for database connections

### 3. Plugin System Enhancements
- Auto-pass common config values (adapter, schemas) to plugins
- Plugin dependency management
- Hot-reloading of plugin changes during development

### 4. Type Safety
- Better TypeScript definitions for plugin interfaces
- Runtime type checking for generated code
- Validation of database schema compatibility

### 5. Performance
- Cache introspection results during development
- Parallel plugin execution
- Incremental generation based on schema changes

## Key Dependencies
- `pg-introspection`: Database analysis
- `recast`: AST manipulation for code generation  
- `lilconfig`: Configuration loading
- `graphile-migrate`: Database migration management
- `zod`: Runtime type validation

## Testing Strategy
- Unit tests for individual plugins
- Integration tests with real database schemas
- Configuration validation tests
- Generated code compilation tests

## Notes for Future Development
1. Always test with `bun dev` after significant changes
2. Check for import/parameter naming conflicts in plugins
3. Validate that adapter configuration flows through entire system
4. Consider database connection pooling for better performance
5. Add comprehensive error handling for database connection failures
