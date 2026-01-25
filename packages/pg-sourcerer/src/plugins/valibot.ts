/**
 * Valibot Plugin - Generates Valibot schemas for entities
 *
 * Generates Valibot schemas for Row, Insert, Update, and Patch shapes,
 * with optional inferred TypeScript types.
 *
 * Capabilities provided:
 * - `schema:valibot:EntityName` for each table entity (Row schema)
 * - `schema:valibot:EntityName:insert` for Insert shape
 * - `schema:valibot:EntityName:update` for Update shape
 * - `schema:valibot:EnumName` for enum entities
 */
import { Effect, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { IR } from "../services/ir.js";
import {
  isTableEntity,
  isEnumEntity,
  type TableEntity,
  type Field,
  type EnumEntity,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type { SchemaBuilder } from "../ir/extensions/schema-builder.js";
import {
  PG_STRING_TYPES,
  PG_NUMBER_TYPES,
  PG_BOOLEAN_TYPES,
  PG_DATE_TYPES,
  PG_JSON_TYPES,
  resolveFieldTypeInfo,
} from "./shared/pg-types.js";
import {
  buildEnumDeclarations,
  buildSchemaBuilderDeclaration,
  buildShapeDeclarations,
} from "./shared/schema-declarations.js";

const b = conjure.b;

const ValibotSchemaConfig = S.Struct({
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
});

type SchemaConfig = S.Schema.Type<typeof ValibotSchemaConfig>;

export interface ValibotConfig {
  exportTypes?: boolean;
  schemasFile?: string | FileNaming;
}

interface ResolvedValibotConfig extends SchemaConfig {
  schemasFile: FileNaming;
}

type ValibotMapping =
  | { kind: "schema"; schema: n.Expression; enumRef?: undefined }
  | { kind: "enumRef"; enumRef: string; schema?: undefined };

function fieldToValibotMapping(field: Field, enums: EnumEntity[]): ValibotMapping {
  const resolved = resolveFieldTypeInfo(field);
  if (!resolved) {
    return { kind: "schema", schema: conjure.id("v").method("unknown").build() };
  }
  const baseResult = baseTypeToValibotMapping(resolved.typeName, resolved.typeInfo, enums);

  if (baseResult.kind === "enumRef") {
    return baseResult;
  }

  let schema = baseResult.schema;

  if (field.isArray) {
    schema = conjure.id("v").method("array", [schema]).build();
  }

  const methods: string[] = [];
  if (field.nullable) methods.push("nullable");
  if (field.optional) methods.push("optional");

  for (const method of methods) {
    schema = conjure.id("v").method(method, [schema]).build();
  }

  return { kind: "schema", schema };
}

function baseTypeToValibotMapping(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): ValibotMapping {
  const normalized = typeName.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) {
    if (normalized === "uuid") {
      const uuidSchema = conjure
        .id("v")
        .method("pipe", [
          conjure.id("v").method("string").build(),
          conjure.id("v").method("uuid").build(),
        ])
        .build();
      return { kind: "schema", schema: uuidSchema };
    }
    return { kind: "schema", schema: conjure.id("v").method("string").build() };
  }

  if (PG_NUMBER_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("v").method("number").build() };
  }

  if (PG_BOOLEAN_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("v").method("boolean").build() };
  }

  if (PG_DATE_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("v").method("date").build() };
  }

  if (PG_JSON_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("v").method("unknown").build() };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "schema", schema: conjure.id("v").method("unknown").build() };
  }

  return { kind: "schema", schema: conjure.id("v").method("unknown").build() };
}

function shapeToValibotObject(
  shape: { fields: readonly Field[] },
  enums: EnumEntity[],
  registry: SymbolRegistryService,
): n.Expression {
  const properties = shape.fields.map(field => {
    const mapping = fieldToValibotMapping(field, enums);

    let value: n.Expression;
    if (mapping.kind === "enumRef") {
      const enumHandle = registry.import(`schema:valibot:${mapping.enumRef}`);
      value = enumHandle.ref() as n.Expression;

      if (field.isArray) {
        value = conjure.id("v").method("array", [value]).build();
      }
      if (field.nullable) {
        value = conjure.id("v").method("nullable", [value]).build();
      }
      if (field.optional) {
        value = conjure.id("v").method("optional", [value]).build();
      }
    } else {
      value = mapping.schema;
    }

    return b.objectProperty(b.identifier(field.name), cast.toExpr(value));
  });

  const objExpr = b.objectExpression(properties);
  const vObject = b.callExpression(b.memberExpression(b.identifier("v"), b.identifier("object")), [
    objExpr,
  ]);
  return vObject;
}

function createValibotConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure
      .id("v")
      .method("parse", [conjure.id(schemaName).build(), cast.toExpr(input as n.Expression)])
      .build();
  };
}

const valibotSchemaBuilder: SchemaBuilder = {
  build(request) {
    if (request.params.length === 0) {
      return undefined;
    }

    let objBuilder = conjure.obj();
    for (const param of request.params) {
      const valibotType = paramToValibotType(param);
      objBuilder = objBuilder.prop(param.name, valibotType);
    }

    const ast = conjure.id("v").method("object", [objBuilder.build()]).build();
    const consume = (input: n.Expression) =>
      b.callExpression(b.memberExpression(b.identifier("v"), b.identifier("parse")), [
        cast.toExpr(ast),
        cast.toExpr(input),
      ]);

    return {
      ast,
      importSpec: { from: "valibot", names: ["v"] },
      consume,
    };
  },
};

function paramToValibotType(param: { type: string; required: boolean }) {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();
  let valibotSchema: n.Expression;

  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      valibotSchema = conjure
        .id("v")
        .method("pipe", [
          conjure.id("v").method("string").build(),
          conjure
            .id("v")
            .method("transform", [
              b.arrowFunctionExpression([b.identifier("s")], b.identifier("Number")),
            ])
            .build(),
        ])
        .build();
      break;
    case "boolean":
    case "bool":
      valibotSchema = conjure
        .id("v")
        .method("pipe", [
          conjure.id("v").method("string").build(),
          conjure
            .id("v")
            .method("transform", [
              b.arrowFunctionExpression(
                [b.identifier("v")],
                conjure.op.eq(b.identifier("v"), b.stringLiteral("true")),
              ),
            ])
            .build(),
        ])
        .build();
      break;
    case "bigint":
      valibotSchema = conjure
        .id("v")
        .method("pipe", [
          conjure.id("v").method("string").build(),
          conjure
            .id("v")
            .method("transform", [
              b.arrowFunctionExpression([b.identifier("s")], b.identifier("BigInt")),
            ])
            .build(),
        ])
        .build();
      break;
    case "date":
      valibotSchema = conjure
        .id("v")
        .method("pipe", [
          conjure.id("v").method("string").build(),
          conjure
            .id("v")
            .method("transform", [
              b.arrowFunctionExpression(
                [b.identifier("s")],
                b.newExpression(b.identifier("Date"), [b.identifier("s")]),
              ),
            ])
            .build(),
        ])
        .build();
      break;
    case "string":
    default:
      valibotSchema = conjure.id("v").method("string").build();
      break;
  }

  if (!param.required) {
    valibotSchema = conjure.id("v").method("optional", [valibotSchema]).build();
  }

  return valibotSchema;
}

export function valibot(config?: ValibotConfig): Plugin {
  const schemaConfig = S.decodeSync(ValibotSchemaConfig)(config ?? {});

  const resolvedConfig: ResolvedValibotConfig = {
    ...schemaConfig,
    schemasFile: normalizeFileNaming(config?.schemasFile, "schemas.ts"),
  };

  return {
    name: "valibot",

    provides: ["schema"],

    fileDefaults: [
      {
        pattern: "schema:",
        fileNaming: resolvedConfig.schemasFile,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          declarations.push(...buildShapeDeclarations(entity, "schema:valibot"));
        } else if (isEnumEntity(entity)) {
          declarations.push(...buildEnumDeclarations(entity, "schema:valibot"));
        }
      }

      declarations.push(buildSchemaBuilderDeclaration("valibotSchemaBuilder", "schema:valibot"));

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;

      const enums = [...ir.entities.values()].filter(isEnumEntity);

      const rendered: RenderedSymbol[] = [];

      for (const entity of ir.entities.values()) {
        if (isTableEntity(entity)) {
          const shapes: NonNullable<TableEntity["shapes"]["row" | "insert" | "update"]>[] = [
            entity.shapes.row,
          ];
          if (entity.shapes.insert) shapes.push(entity.shapes.insert);
          if (entity.shapes.update) shapes.push(entity.shapes.update);

          for (const shape of shapes) {
            const isRow = shape.kind === "row";
            const capability = `schema:valibot:${shape.name}`;

            const schemaNode = registry.forSymbol(capability, () =>
              shapeToValibotObject(shape, enums, registry),
            );

            const schemaDecl = conjure.export.const(shape.name, schemaNode);

            rendered.push({
              name: shape.name,
              capability,
              node: schemaDecl,
              exports: "named",
              externalImports: [{ from: "valibot", names: ["v"] }],
              metadata: {
                consume: createValibotConsumeCallback(shape.name),
              },
            });

            if (resolvedConfig.exportTypes && !isRow) {
              const inferType = conjure.ts.qualifiedRef("v", "InferOutput", [
                conjure.ts.typeof(shape.name),
              ]);
              const typeDecl = conjure.export.type(shape.name, inferType);

              rendered.push({
                name: shape.name,
                capability: `schema:valibot:${shape.name}:type`,
                node: typeDecl,
                exports: "named",
                externalImports: [{ from: "valibot", names: ["v"] }],
              });
            }
          }
        } else if (isEnumEntity(entity)) {
          const schemaNode = conjure
            .id("v")
            .method("picklist", [conjure.arr(...entity.values.map(v => conjure.str(v))).build()])
            .build();

          const schemaDecl = conjure.export.const(entity.name, schemaNode);

          const inferType = conjure.ts.qualifiedRef("v", "InferOutput", [
            conjure.ts.typeof(entity.name),
          ]);
          const typeDecl = conjure.export.type(entity.name, inferType);

          rendered.push({
            name: entity.name,
            capability: `schema:valibot:${entity.name}`,
            node: schemaDecl,
            exports: "named",
            externalImports: [{ from: "valibot", names: ["v"] }],
            metadata: {
              consume: createValibotConsumeCallback(entity.name),
            },
          });

          if (resolvedConfig.exportTypes) {
            rendered.push({
              name: entity.name,
              capability: `schema:valibot:${entity.name}:type`,
              node: typeDecl,
              exports: "named",
              externalImports: [{ from: "valibot", names: ["v"] }],
            });
          }
        }
      }

      rendered.push({
        name: "valibotSchemaBuilder",
        capability: "schema:valibot:builder",
        node: null,
        exports: false,
        metadata: {
          builder: valibotSchemaBuilder,
        },
      });

      return rendered;
    }),
  };
}
