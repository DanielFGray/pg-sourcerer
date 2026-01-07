/**
 * Test fixtures for pg-sourcerer
 *
 * Provides pre-captured introspection data from the example database
 * so tests can run without a live database connection.
 */
import { parseIntrospectionResults, type Introspection } from "pg-introspection";
import introspectionData from "./introspection.json" with { type: "json" };

/**
 * Load the introspection fixture.
 * This is pre-captured data from packages/example database.
 *
 * To regenerate: bun scripts/generate-fixture.ts
 */
export function loadIntrospectionFixture(): Introspection {
  // parseIntrospectionResults expects a JSON string
  return parseIntrospectionResults(JSON.stringify(introspectionData), true);
}
