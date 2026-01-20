import {
  defineConfig,
  type FileNamingContext,
  arktype,
  kysely,
  // sqlQueries,
  // zod,
  // elysia,
  // httpExpress,
  // httpHono,
  trpc,
  // httpOrpc,
  // valibot,
  // typesPlugin,
  // effect,
  userModule,
} from "@danielfgray/pg-sourcerer";
export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    arktype({
      exportTypes: true,
      schemasFile: ({ baseEntityName }: FileNamingContext) => `${baseEntityName}/schemas.ts`,
    }),
    kysely({
      dbImport: userModule("./db.ts", { named: ["db"] }),
      typesFile: "DB.ts",
      queriesFile: ({ entityName }: FileNamingContext) => `${entityName}/queries.ts`,
    }),
    trpc({
      trpcImport: userModule("./trpc.ts", { named: ["router", "publicProcedure"] }),
      routesFile: ({ entityName }: FileNamingContext) => `${entityName}/router.ts`,
    }),
  ],
});
