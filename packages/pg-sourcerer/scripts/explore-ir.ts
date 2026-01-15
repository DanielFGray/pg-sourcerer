#!/usr/bin/env bun
/**
 * Exploration script for query generation prototyping
 */
import { Effect } from "effect";
import { parseIntrospectionResults } from "@danielfgray/pg-introspection";
import { createIRBuilderService } from "../src/services/ir-builder.js";
import { InflectionLive } from "../src/services/inflection.js";
import { 
  getTableEntities, 
  getAllRelations, 
} from "../src/ir/semantic-ir.js";

// Load fixture as string (parseIntrospectionResults expects JSON string)
const fixtureJson = await Bun.file(import.meta.dirname + "/../src/__tests__/fixtures/introspection.json").text();

// Hydrate introspection (pg-introspection expects JSON string)
const introspection = parseIntrospectionResults(fixtureJson, false);

// Build IR
const ir = await Effect.runPromise(
  Effect.gen(function* () {
    const builder = createIRBuilderService();
    return yield* builder.build(introspection, { schemas: ["app_public"] });
  }).pipe(Effect.provide(InflectionLive))
);

console.log("\n=== Tables in IR ===");
const tables = getTableEntities(ir);
tables.forEach(t => console.log(`  ${t.name} (${t.pgName})`));

console.log("\n=== Relations for each table ===");
for (const table of tables) {
  const rels = getAllRelations(ir, table.name);
  if (!rels) continue;
  
  console.log(`\n${table.name}:`);
  if (rels.belongsTo.length > 0) {
    console.log("  belongsTo:");
    rels.belongsTo.forEach(r => {
      const cols = r.columns.map(c => `${c.local} -> ${c.foreign}`).join(", ");
      console.log(`    -> ${r.targetEntity} via ${r.constraintName} (${cols})`);
    });
  }
  if (rels.hasMany.length > 0) {
    console.log("  hasMany:");
    rels.hasMany.forEach(r => {
      const cols = r.columns.map(c => `${c.local} <- ${c.foreign}`).join(", ");
      console.log(`    <- ${r.sourceEntity} via ${r.constraintName} (${cols})`);
    });
  }
}

console.log("\n=== Indexes (useful for query optimization) ===");
for (const table of tables) {
  if (table.indexes.length > 0) {
    console.log(`\n${table.name}:`);
    table.indexes.forEach(idx => {
      const attrs = [
        idx.isPrimary ? "PK" : null,
        idx.isUnique ? "UNIQUE" : null,
        idx.isPartial ? "PARTIAL" : null,
      ].filter(Boolean).join(",");
      console.log(`  ${idx.name} (${idx.method}): [${idx.columns.join(", ")}] ${attrs}`);
    });
  }
}

