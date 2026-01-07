# ast-grep Patterns for pg-sourcerer

Common code transformation patterns using ast-grep.

## Basic Syntax

| Pattern | Meaning |
|---------|---------|
| `$VAR` | Match any single AST node |
| `$$$ARGS` | Match zero or more nodes (for args, statements) |
| `$_VAR` | Match but don't capture |

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
