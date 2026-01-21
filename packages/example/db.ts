import postgres from "postgres";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { PgClient } from "@effect/sql-pg";
import { Config } from "effect";
// import type { DB } from "./generated/DB.js";

export const sql = postgres(process.env.DATABASE_URL!);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

/**
 * Effect SQL layer for PostgreSQL connection.
 * Reads DATABASE_URL from environment via Effect Config.
 */
export const SqlLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});
