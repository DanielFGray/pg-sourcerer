import {
  defineConfig,
  arktype,
  kysely,
  sqlQueriesPlugin,
  zod,
  httpElysia,
  httpExpress,
  httpHono,
  httpTrpc,
  httpOrpc,
  valibot,
  typesPlugin,
  effect,
} from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.DATABASE_URL!,
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    // typesPlugin(),
    // zod({ exportTypes: true }),
    // arktype({ exportTypes: true }),
    valibot({ exportTypes: true }),

    kysely({
      generateQueries: true,
      explicitColumns: true,
      dbAsParameter: false,
      header: `import { db } from "../../db.js";`,
    }),

    // sqlQueriesPlugin({
    //   sqlStyle: "tag",
    //   header: `import { sql } from "../../db.js";`,
    // }),

    // httpElysia({ basePath: "/api" }),
    // httpExpress({ basePath: "/api" }),
    // httpHono({ basePath: "/api" }),

    // httpTrpc({
    //   outputDir: "trpc",
    //   header: `import { router, publicProcedure } from "../../trpc.js";`,
    // }),

    // httpOrpc({
    //   outputDir: "orpc",
    //   header: `import { os } from "@orpc/server";`,
    // }),
    httpExpress({}),
    // httpHono(),

    // effect(),
  ],
});
