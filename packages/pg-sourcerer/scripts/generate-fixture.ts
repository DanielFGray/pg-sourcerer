#!/usr/bin/env bun
/**
 * Generate introspection fixture from the example database
 *
 * Usage:
 *   bun scripts/generate-fixture.ts                    # owner fixture (default)
 *   bun scripts/generate-fixture.ts --role visitor     # visitor fixture
 *
 * Requires: cd packages/example && docker compose up
 */
import { Effect } from "effect"
import { writeFileSync } from "fs"
import { join } from "path"
import { introspectDatabase } from "../src/services/introspection.js"
import { parseArgs } from "util"

const { DATABASE_URL } = process.env

async function main() {
  if (!DATABASE_URL) {
    console.error("Please set the DATABASE_URL environment variable.")
    process.exit(1)
  }

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      role: { type: "string", short: "r" },
    },
  })

  const role = values.role

  const introspection = await Effect.runPromise(
    introspectDatabase({
      connectionString: DATABASE_URL,
      ...(role ? { role } : {}),
    })
  )

  const filename = role ? `${role}_introspection.json` : "introspection.json"
  const fixturePath = join(
    import.meta.dirname,
    "../src/__tests__/fixtures",
    filename
  )

  const json = JSON.stringify(introspection, null, 2)
  writeFileSync(fixturePath, json)

  console.log(`Wrote fixture to ${fixturePath}`)
  console.log(`Role: ${role ?? "(connection default)"}`)
  console.log(`Size: ${(json.length / 1024).toFixed(1)} KB`)
}

main().catch((err) => {
  console.error("Failed to generate fixture:", err)
  process.exit(1)
})
