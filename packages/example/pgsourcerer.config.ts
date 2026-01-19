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
      generateQueries: true,
      dbAsParameter: false,
      header: `import { db } from "../../db.js";`,
      typesFile: "db.ts",
      queriesFile: ({ entityName }: FileNamingContext) => `${entityName}/queries.ts`,
    }),
    trpc({
      routesFile: ({ entityName }: FileNamingContext) => `${entityName}/router.ts`,
    }),
  ],
});
