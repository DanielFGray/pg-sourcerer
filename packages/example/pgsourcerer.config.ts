import {
  defineConfig,
  arktypePlugin,
  kyselyTypesPlugin,
  kyselyQueriesPlugin,
  sqlQueriesPlugin,
  zodPlugin,
  httpElysiaPlugin,
  httpTrpcPlugin,
  httpOrpcPlugin,
  valibotPlugin,
  typesPlugin,
} from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.AUTH_DATABASE_URL!,
  role: "visitor",
  schemas: ["app_public", "app_private"],
  outputDir: "./generated",
  formatter: "bunx oxfmt --write",
  plugins: [
    typesPlugin(),

    // zodPlugin({ exportTypes: true }),
    // arktypePlugin({ exportTypes: true }),
    // valibotPlugin(),

    // kyselyTypesPlugin(),
    // kyselyQueriesPlugin({
    //   explicitColumns: true,
    //   dbAsParameter: false,
    //   header: `import { db } from "../../db.js";`,
    // }),

    sqlQueriesPlugin({
      sqlStyle: "tag",
      header: `import { sql } from "../../db.js";`,
    }),

    httpElysiaPlugin(),
    // httpTrpcPlugin(),
    // httpOrpcPlugin(),
  ],
});
