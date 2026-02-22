import {
  defineConfig,
  arktype,
  zod,
  valibot,
  typesPlugin,
  kysely,
  sqlQueries,
  elysia,
  express,
  hono,
  trpc,
  orpc,
  effect,
  userModule,
} from "@danielfgray/pg-sourcerer";
export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  role: "visitor",
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    kysely({
      dbImport: userModule("./db.ts", { named: ["db"] }),
    }),
    zod(),
    elysia(),
  ],
});
