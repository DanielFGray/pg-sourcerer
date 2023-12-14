import fs from "fs/promises";
import config from "./.kanelrc.cjs";
import { TypeDefinition, processDatabase } from "kanel";
import {
  Schema,
  TableColumn,
  TableColumnType,
  TableDetails,
  extractSchemas,
} from "extract-pg-schema";
import _debug from "debug";
import path from "path";

const debug = _debug("pg-gen-query");

type QueryData = {
  name: string;
  query: string;
  args: Array<[string, { default?: any; type: string }]>;
  returnType: string;
};

function getTSType(columnType: TableColumnType) {
  switch (columnType.fullName) {
    case "int4":
      return "number";
    default:
      return String(config.customTypeMap?.[columnType.fullName] ?? "string");
  }
}

function getOperatorFromColumn(column: TableColumn) {
  switch (true) {
    case column.type.fullName === "pg_catalog.tsvector":
      return "@@";
    case column.isArray:
      return "@>";
    default:
      return "=";
  }
}

function processTable(
  table: TableDetails,
  { schema }: { schema: Schema },
) {
  const tableName =
    schema.name === "public" ? table.name : `${schema.name}.${table.name}`;
  debug(`found table ${tableName}`);
  const singularTableName = table.name.replace(/s$/, "");
  const typeName = singularTableName[0]
    .toUpperCase()
    .concat(singularTableName.slice(1));
  const qs: Array<QueryData> = [
    {
      name: `select_all_${table.name}`,
      query: `select * from ${tableName} limit $1 offset $2`,
      args: [
        ["limit", { default: 100, type: "number" }],
        ["offset", { default: 0, type: "number" }],
      ],
      returnType: `Array<${typeName}>`,
    },
  ];
  const indices = table.columns
    .filter((c) => c.indices.length)
    .map((column) => {
      debug(
        `found index on ${table.name}.${column.name} on type ${column.type.fullName}`,
      );
      if (column.type.fullName === "pg_catalog.timestamptz") {
        return {
          name: `select_${table.name}_by_${column.name}`,
          query: `select * from ${tableName} order by ${column.name} limit $1 offset $2`,
          args: [
            ["limit", { default: 100, type: "number" }],
            ["offset", { default: 0, type: "number" }],
          ],
          returnType: `Array<${typeName}>`,
        };
      }
      return {
        name: `select_${table.name}_by_${column.name}`,
        query: `select * from ${tableName} where ${
          column.name
        } ${getOperatorFromColumn(column)} $1 limit $2 offset $3`,
        args: [
          [column.name, { type: getTSType(column.type) }],
          ["limit", { default: 100, type: "number" }],
          ["offset", { default: 0, type: "number" }],
        ],
        returnType: `Array<${typeName}>`,
      };
    }) satisfies QueryData[];
  indices.forEach((e) => qs.push(e));
  const references = table.columns
    .filter((c) => c.references?.length)
    .map((column) => {
      debug(
        `${tableName} references ${column.references[0].tableName}.${column.references[0].columnName}`,
      );
      return column;
    }) satisfies QueryData[];
  // references.forEach((e) => qs.push(e));
  // const imports = new Set(typeName);
  return qs;
}

function processSchema(schema, { tableNames }) {
  return schema.tables
    .filter((t) => tableNames.includes(t.name))
    .flatMap((t) => processTable(t, { schema }));
}

const adapters = {
  toFunction: (e: QueryData, body) => {
    const params =
      !e.args || e.args.length < 1
        ? ""
        : `{ ${e.args
            .map(([a, d]) =>
              d.default === undefined ? a : `${a} = ${d.default}`,
            )
            .join(", ")} }: { ${e.args
            .map(([a, d]) => `${a}: ${d.type}`)
            .join(", ")} }`;
    return `export async function ${e.name}(${params}): Promise<${e.returnType}> {
  ${body}
}`;
  },
  postgres: (e: QueryData) => {
    return `return sql\`${e.query.replace(/\$(\d)/g, (line, match) => {
      return `\${${e.args[match - 1]?.[0]}}`;
    })}\``;
  },
  pg: (e: QueryData) => `const { rows } = await pool.query('${
    e.query
  }', [${e.args.map((a) => a[0]).join(", ")}])
  return rows`,
};

async function main() {
  const result = await extractSchemas(config.connection, {
    schemas: config.schemas,
  });

  await processDatabase(config);

  const processed = Object.entries(result)
    .flatMap(([name, schema]) =>
      processSchema(schema, { tableNames: config.tableNames, config }),
    )
    .map((e) => adapters.toFunction(e, adapters[config.adapter](e)))
    .join("\n\n");

  await fs.writeFile(path.join(config.outputPath, "db-queries.ts"), processed);
  console.log(processed);
}
main().catch(console.error);
