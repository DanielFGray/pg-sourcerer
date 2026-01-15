# ast-grep Patterns for pg-sourcerer

Common code transformation patterns using ast-grep.

## Basic Syntax

| Pattern   | Meaning                                         |
| --------- | ----------------------------------------------- |
| `$VAR`    | Match any single AST node                       |
| `$$$ARGS` | Match zero or more nodes (for args, statements) |
| `$_VAR`   | Match but don't capture                         |

## CLI Commands

```bash
# Preview changes
ast-grep run -p '<pattern>' --rewrite '<replacement>' --lang typescript

# Apply changes
ast-grep run -p '<pattern>' --rewrite '<replacement>' --lang typescript -U

# Interactive mode
ast-grep run -p '<pattern>' --lang typescript -i

# Restrict to specific files
ast-grep run -p '<pattern>' --lang typescript --globs '**/some-file.ts' -U
```

## Plugin Factory Migration

When changing from direct plugin access to factory pattern:

```bash
# somePlugin.run(...) → somePlugin.plugin.run(...)
ast-grep run -p 'effectModelPlugin.run($$$ARGS)' --rewrite 'effectModelPlugin.plugin.run($$$ARGS)' --lang typescript -U
ast-grep run -p 'typesPlugin.run($$$ARGS)' --rewrite 'typesPlugin.plugin.run($$$ARGS)' --lang typescript -U
ast-grep run -p 'zodPlugin.run($$$ARGS)' --rewrite 'zodPlugin.plugin.run($$$ARGS)' --lang typescript -U

# somePlugin.provides → somePlugin.plugin.provides
ast-grep run -p 'effectModelPlugin.provides' --rewrite 'effectModelPlugin.plugin.provides' --lang typescript -U
ast-grep run -p 'typesPlugin.provides' --rewrite 'typesPlugin.plugin.provides' --lang typescript -U
ast-grep run -p 'zodPlugin.provides' --rewrite 'zodPlugin.plugin.provides' --lang typescript -U

# somePlugin.requires → somePlugin.plugin.requires
ast-grep run -p 'effectModelPlugin.requires' --rewrite 'effectModelPlugin.plugin.requires' --lang typescript -U
ast-grep run -p 'typesPlugin.requires' --rewrite 'typesPlugin.plugin.requires' --lang typescript -U
ast-grep run -p 'zodPlugin.requires' --rewrite 'zodPlugin.plugin.requires' --lang typescript -U

# somePlugin.name → somePlugin.plugin.name
ast-grep run -p 'effectModelPlugin.name' --rewrite 'effectModelPlugin.plugin.name' --lang typescript -U
ast-grep run -p 'typesPlugin.name' --rewrite 'typesPlugin.plugin.name' --lang typescript -U
ast-grep run -p 'zodPlugin.name' --rewrite 'zodPlugin.plugin.name' --lang typescript -U
```

## configured() Helper Removal

When removing the `configured(plugin, config)` helper in favor of direct `plugin(config)` calls:

```bash
# Use sed for simple pattern (ast-grep would work too)
sed -i 's/configured(\([^)]*\))/\1({})/g' src/__tests__/plugin-runner.test.ts
```

## Generic Patterns

```bash
# Match any method call on any plugin
ast-grep run -p '$PLUGIN.run($$$ARGS)' --lang typescript

# Match property access
ast-grep run -p '$PLUGIN.provides' --lang typescript
```

## Array to Function Transformation

Converting string arrays to function calls (e.g., inflection config migration):

```bash
# Single-element array → direct function reference
# ["camelCase"] → inflect.camelCase
ast-grep run -p '["$A"]' --rewrite 'inflect.$A' --lang TypeScript -U <files>

# Two-element array → composed function
# ["singularize", "pascalCase"] → (name) => inflect.pascalCase(inflect.singularize(name))
ast-grep run -p '["$A", "$B"]' --rewrite '(name) => inflect.$B(inflect.$A(name))' --lang TypeScript -U <files>

# Three-element array (rare but possible)
# ["singularize", "pascalCase", "uppercase"] → (name) => inflect.uppercase(inflect.pascalCase(inflect.singularize(name)))
ast-grep run -p '["$A", "$B", "$C"]' --rewrite '(name) => inflect.$C(inflect.$B(inflect.$A(name)))' --lang TypeScript -U <files>
```

**Order matters!** Run two-element patterns before single-element to avoid partial matches.

**Watch out for false positives:** Array patterns like `["$A"]` will match ANY single-element string array, including things like `schemas: ["public"]`. Review the dry-run output before applying with `-U`.

## CLI Behavior Notes

- **Default is dry-run**: Shows diff but doesn't modify files
- **`-U` or `--update-all`**: Actually applies changes (no confirmation)
- **`-i`**: Interactive mode - confirm each change
- **`--json`**: Machine-readable output with replacement details
- **`--lang TypeScript`**: Required for `.ts` files (case-sensitive)
