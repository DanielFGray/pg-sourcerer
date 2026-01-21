/**
 * Database Introspection Service
 *
 * Provides typed database introspection using pg-introspection.
 */
import { Effect, Context } from "effect";
import pg from "pg";
import {
  makeIntrospectionQuery,
  parseIntrospectionResults,
  type Introspection,
} from "@danielfgray/pg-introspection";
import { ConnectionFailed, IntrospectionFailed } from "../errors.js";

/**
 * Options for introspection
 */
export interface IntrospectOptions {
  /** PostgreSQL connection string */
  readonly connectionString: string;
  /** Optional role to set before introspecting (for RLS) */
  readonly role?: string;
}

/**
 * Introspection service interface
 */
export interface DatabaseIntrospection {
  /**
   * Introspect a database and return parsed results
   */
  readonly introspect: (
    options: IntrospectOptions,
  ) => Effect.Effect<Introspection, ConnectionFailed | IntrospectionFailed>;
}

/**
 * Service tag for dependency injection
 */
export class DatabaseIntrospectionService extends Context.Tag("DatabaseIntrospection")<
  DatabaseIntrospectionService,
  DatabaseIntrospection
>() {}

/**
 * Live implementation using pg
 */
export const DatabaseIntrospectionLive = Effect.sync(() => createDatabaseIntrospection());

/**
 * Create a DatabaseIntrospection implementation
 */
export function createDatabaseIntrospection(): DatabaseIntrospection {
  return {
    introspect: options =>
      Effect.gen(function* () {
        const { connectionString, role } = options;

        // Create pool and connect
        const pool = new pg.Pool({ connectionString });
        const client = yield* Effect.tryPromise({
          try: () => pool.connect(),
          catch: error =>
            new ConnectionFailed({
              message: `Failed to connect to database`,
              connectionString: connectionString.replace(/:[^:@]+@/, ":***@"), // Hide password
              cause: error,
            }),
        });

        try {
          // Begin transaction
          yield* Effect.tryPromise({
            try: () => client.query("begin"),
            catch: error =>
              new IntrospectionFailed({
                message: "Failed to begin transaction",
                schema: "*",
                cause: error,
              }),
          });

          // Set role if specified
          if (role) {
            yield* Effect.tryPromise({
              try: () => client.query("select set_config('role', $1, false)", [role]),
              catch: error =>
                new IntrospectionFailed({
                  message: `Failed to set role to '${role}'`,
                  schema: "*",
                  cause: error,
                }),
            });
          }

          // Run introspection query
          const result = yield* Effect.tryPromise({
            try: () => client.query<{ introspection: string }>(makeIntrospectionQuery()),
            catch: error =>
              new IntrospectionFailed({
                message: "Introspection query failed",
                schema: "*",
                cause: error,
              }),
          });

          const rawIntrospection = result.rows[0]?.introspection;
          if (!rawIntrospection) {
            return yield* Effect.fail(
              new IntrospectionFailed({
                message: "Introspection returned no results",
                schema: "*",
                cause: null,
              }),
            );
          }

          // Rollback (we only read)
          yield* Effect.tryPromise({
            try: () => client.query("rollback"),
            catch: error =>
              new IntrospectionFailed({
                message: "Failed to rollback transaction",
                schema: "*",
                cause: error,
              }),
          });

          // Parse results
          return parseIntrospectionResults(rawIntrospection, true);
        } finally {
          client.release();
          yield* Effect.promise(() => pool.end());
        }
      }),
  };
}

/**
 * Convenience function for one-off introspection (e.g., scripts)
 */
export function introspectDatabase(
  options: IntrospectOptions,
): Effect.Effect<Introspection, ConnectionFailed | IntrospectionFailed> {
  return createDatabaseIntrospection().introspect(options);
}
