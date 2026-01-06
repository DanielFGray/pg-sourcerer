#!/usr/bin/env bun
/**
 * Generate introspection fixture from the example database
 *
 * Run: bun scripts/generate-fixture.ts
 * Requires: cd packages/example && docker compose up
 */
import { Effect } from "effect"
import { writeFileSync } from "fs"
import { join } from "path"
import { introspectDatabase } from "../src/services/introspection.js"

const DATABASE_URL =
  // eslint-disable-next-line @typescript-eslint/dot-notation
  process.env["DATABASE_URL"] ??
  "postgresql://pgsourcerer_demo:YwxPS2MX9o1LKBweB6Dgha3v@localhost:5432/pgsourcerer_demo"

async function main() {
  const introspection = await Effect.runPromise(
    introspectDatabase({
      connectionString: DATABASE_URL,
      role: "visitor",
    })
  )

  // Introspection object needs to be serialized
  // We stringify it directly since pg-introspection parses JSON internally
  const fixturePath = join(
    import.meta.dirname,
    "../src/__tests__/fixtures/introspection.json"
  )

  const json = JSON.stringify(introspection, null, 2)
  writeFileSync(fixturePath, json)

  console.log(`Wrote fixture to ${fixturePath}`)
  console.log(`Size: ${(json.length / 1024).toFixed(1)} KB`)
}

main().catch((err) => {
  console.error("Failed to generate fixture:", err)
  process.exit(1)
})
