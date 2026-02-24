# README spec blocks (Code Hike)

Source of truth for README examples lives in `docs/spec/README.mdx`.
This file defines the block schema + conventions used by the parser,
verification, and README compiler.

## Block schema

The spec is parsed with `codehike/blocks` using `parseRoot` and zod.
Blocks are created from decorated headings, paragraphs, and code blocks.

### Root

- `sections`: array of `Section` blocks (via `## !!section <id>`)

### Section block

Decorated heading creates a block with nested content until the next
same-level heading.

- `title`: heading text
- `children`: prose content (optional)
- `claims`: array of `Claim` blocks (via `### !!claim <id>`)

### Claim block

Each claim represents a README statement that must be proven against
generated code.

Required:
- `id`: string (kebab-case)

Optional:
- `title`: heading text
- `plugin`: string (plugin key or display name)
- `file`: string (path to generated file, relative to repo root)
- `source`: string (README section anchor or note)
- `expected`: CodeBlock (decorated code block)
- `actual`: CodeBlock (decorated code block)
- `notes`: string (decorated paragraph for extra context)

### CodeBlock

Decorated code block provides:

- `lang`: string (e.g. "ts")
- `meta`: string (rest of fence line, optional)
- `value`: string (code contents)

## Conventions

- `section` ids: kebab-case, stable identifiers.
- `claim` ids: kebab-case, unique across the doc.
- `file`: workspace-relative path, no leading slash.
- `expected`: canonical snippet for verification.
- `actual`: empty placeholder in spec, filled by compiler.
- `source`: use README anchors (e.g. `#plugins`) when possible.
- Keep prose minimal; specs should be mostly machine-checked.

## MDX layout

Example structure:

```mdx
## !!section plugins
Plugin outputs and guarantees.

### !!claim types-user
!plugin typesPlugin
!file packages/example/src/generated/types/User.ts
!source #what-gets-generated

```ts !expected
export interface User {
  id: string
}
```

```ts !actual
```

### !!claim zod-user
!plugin zod
!file packages/example/src/generated/schemas/User.ts

```ts !expected
export const User = z.object({
  id: z.string().uuid(),
})
```

```ts !actual
```
```

## Parser sketch

```ts
import { z } from "zod"
import { parseRoot, Block, CodeBlock } from "codehike/blocks"

const Claim = Block.extend({
  id: z.string(),
  plugin: z.string().optional(),
  file: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  expected: CodeBlock.optional(),
  actual: CodeBlock.optional(),
})

const Section = Block.extend({
  claims: z.array(Claim),
})

const Spec = Block.extend({
  sections: z.array(Section),
})

const spec = parseRoot(mdx, Spec)
```

```

## Validation rules

- Every claim must include `expected` or `actual`.
- Claims used for verification must include `file`.
- `actual` is ignored in verification and overwritten in compilation.
- Compilation fails if any `expected` mismatch is detected.
