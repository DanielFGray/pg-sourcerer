import {
  defineConfig,
  type FileNamingContext,
  // arktype,
  // kysely,
  // sqlQueries,
  // zod,
  // elysia,
  // httpExpress,
  // httpHono,
  // trpc,
  // httpOrpc,
  // valibot,
  // typesPlugin,
  effect,
  // userModule,
} from "@danielfgray/pg-sourcerer";
export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    effect(),
  ],
});
