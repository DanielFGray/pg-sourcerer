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

const { DATABASE_URL } = process.env

async function main() {
  if (!DATABASE_URL) {
    console.error("Please set the DATABASE_URL environment variable.")
    process.exit(1)
  }

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
