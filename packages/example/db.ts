import postgres from "postgres";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { DB } from "./generated/db.js";

export const sql = postgres(process.env.DATABASE_URL!);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
