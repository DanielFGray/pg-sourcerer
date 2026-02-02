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
import { Effect, Match, Schema as S, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { IR } from "../services/ir.js";
import type { Field, EnumEntity, DomainEntity } from "../ir/semantic-ir.js";
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
import {
  classifyEntities,
  getEntityShapes,
  applyModifiers,
  applyDomainValidations,
  type ModifierAdapter,
  type ValidationAdapter,
  type BaseTypeAdapter,
  domainBaseSchema,
} from "./shared/schema-entities.js";

const b = conjure.b;

const valibotImport = { from: "valibot", namespace: "v" };

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
  | { kind: "schema"; schema: n.Expression; enumRef?: undefined; domainRef?: undefined }
  | { kind: "enumRef"; enumRef: string; schema?: undefined; domainRef?: undefined }
  | { kind: "domainRef"; domainRef: string; schema?: undefined; enumRef?: undefined };

function fieldToValibotMapping(
  field: Field,
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
): ValibotMapping {
  const resolved = resolveFieldTypeInfo(field);
  if (!resolved) {
    return { kind: "schema", schema: conjure.id("v").method("unknown").build() };
  }
  const baseResult = baseTypeToValibotMapping(resolved.typeName, resolved.typeInfo, enums, domains);

  // For enum/domain references, return as-is (modifiers applied in shapeToValibotObject)
  if (baseResult.kind === "enumRef" || baseResult.kind === "domainRef") {
    return baseResult;
  }

  const withArray = field.isArray
    ? conjure.id("v").method("array", [baseResult.schema!]).build()
    : baseResult.schema!;

  const modifiers = [
    field.nullable && "nullable",
    field.optional && "optional",
  ].filter(Boolean) as string[];

  const schema = modifiers.reduce(
    (s, method) => conjure.id("v").method(method, [s]).build(),
    withArray,
  );

  return { kind: "schema", schema };
}

function baseTypeToValibotMapping(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
): ValibotMapping {
  const normalized = typeName.toLowerCase();

  // Check if this is a domain type
  if (pgType.typtype === "d") {
    const domainEntity = domains.find(d => d.pgType.typname === typeName);
    if (domainEntity) {
      return { kind: "domainRef", domainRef: domainEntity.name };
    }
  }

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

// Valibot-specific adapters for shared helpers
const valibotBaseTypeAdapter: BaseTypeAdapter<n.Expression> = {
  string: () => conjure.id("v").method("string").build(),
  uuid: () =>
    conjure
      .id("v")
      .method("pipe", [
        conjure.id("v").method("string").build(),
        conjure.id("v").method("uuid").build(),
      ])
      .build(),
  number: () => conjure.id("v").method("number").build(),
  boolean: () => conjure.id("v").method("boolean").build(),
  date: () => conjure.id("v").method("date").build(),
  json: () => conjure.id("v").method("unknown").build(),
  unknown: () => conjure.id("v").method("unknown").build(),
};

const valibotModifierAdapter: ModifierAdapter<n.Expression> = {
  array: s => conjure.id("v").method("array", [s]).build(),
  nullable: s => conjure.id("v").method("nullable", [s]).build(),
  optional: s => conjure.id("v").method("optional", [s]).build(),
};

/**
 * Convert a domain entity to a Valibot schema with constraints.
 * Uses v.pipe() to chain validators.
 */
function domainToValibotSchema(domain: DomainEntity): n.Expression {
  const baseValidator = domainBaseSchema(domain, valibotBaseTypeAdapter);

  // Convert validation to valibot validator expression
  const validationToValidator = (
    validation: DomainEntity["constraints"][number]["validations"][number],
  ): n.Expression | null =>
    Match.value(validation).pipe(
      Match.when({ kind: "minLength" }, v =>
        conjure.id("v").method("minLength", [conjure.num(v.value)]).build(),
      ),
      Match.when({ kind: "maxLength" }, v =>
        conjure.id("v").method("maxLength", [conjure.num(v.value)]).build(),
      ),
      Match.when({ kind: "min" }, v =>
        conjure.id("v").method("minValue", [conjure.num(v.value)]).build(),
      ),
      Match.when({ kind: "max" }, v =>
        conjure.id("v").method("maxValue", [conjure.num(v.value)]).build(),
      ),
      Match.when({ kind: "regex" }, v => {
        const flags = v.caseInsensitive ? "i" : "";
        return conjure.id("v").method("regex", [conjure.regex(v.pattern, flags)]).build();
      }),
      Match.orElse(() => null),
    );

  // Collect constraint validators
  const constraintValidators = domain.constraints
    .flatMap(c => c.validations)
    .map(validationToValidator)
    .filter((v): v is n.Expression => v !== null);

  const validators = [baseValidator, ...constraintValidators];

  // If only one validator, return it directly; otherwise use pipe
  return validators.length === 1
    ? validators[0]!
    : conjure.id("v").method("pipe", validators).build();
}

/** Apply Valibot modifiers (array, nullable, optional) to a base expression */
const applyValibotModifiers = (base: n.Expression, field: Field): n.Expression =>
  applyModifiers(base, field, valibotModifierAdapter);

function shapeToValibotObject(
  shape: { fields: readonly Field[] },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  registry: SymbolRegistryService,
): n.Expression {
  const properties = shape.fields.map(field => {
    const mapping = fieldToValibotMapping(field, enums, domains);

    const value: n.Expression = pipe(
      Match.value(mapping.kind),
      Match.when("enumRef", () => {
        const enumHandle = registry.import(`schema:valibot:${mapping.enumRef}`);
        return applyValibotModifiers(enumHandle.ref() as n.Expression, field);
      }),
      Match.when("domainRef", () => {
        const domainHandle = registry.import(`schema:valibot:${mapping.domainRef}`);
        return applyValibotModifiers(domainHandle.ref() as n.Expression, field);
      }),
      Match.orElse(() => mapping.schema!),
    );

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

    const objBuilder = request.params.reduce(
      (builder, param) => builder.prop(param.name, paramToValibotType(param)),
      conjure.obj(),
    );

    const ast = conjure.id("v").method("object", [objBuilder.build()]).build();
    const consume = (input: n.Expression) =>
      b.callExpression(b.memberExpression(b.identifier("v"), b.identifier("parse")), [
        cast.toExpr(ast),
        cast.toExpr(input),
      ]);

    return {
      ast,
      importSpec: valibotImport,
      consume,
    };
  },
};

function paramToValibotType(param: { type: string; required: boolean }) {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  const buildTransformPipe = (transformFn: n.Expression) =>
    conjure.id("v").method("pipe", [
      conjure.id("v").method("string").build(),
      conjure.id("v").method("transform", [transformFn]).build(),
    ]).build();

  const baseSchema = Match.value(baseType).pipe(
    Match.whenOr("number", "int", "integer", "float", "double", () =>
      buildTransformPipe(b.arrowFunctionExpression([b.identifier("s")], b.identifier("Number"))),
    ),
    Match.whenOr("boolean", "bool", () =>
      buildTransformPipe(
        b.arrowFunctionExpression(
          [b.identifier("v")],
          conjure.op.eq(b.identifier("v"), b.stringLiteral("true")),
        ),
      ),
    ),
    Match.when("bigint", () =>
      buildTransformPipe(b.arrowFunctionExpression([b.identifier("s")], b.identifier("BigInt"))),
    ),
    Match.when("date", () =>
      buildTransformPipe(
        b.arrowFunctionExpression(
          [b.identifier("s")],
          b.newExpression(b.identifier("Date"), [b.identifier("s")]),
        ),
      ),
    ),
    Match.orElse(() => conjure.id("v").method("string").build()),
  );

  return param.required ? baseSchema : conjure.id("v").method("optional", [baseSchema]).build();
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
      const { enums, domains, tables } = classifyEntities(ir.entities.values());

      // Domains - declare schema and type exports
      const domainDeclarations = domains.flatMap(entity => [
        { name: entity.name, capability: `schema:valibot:${entity.name}` },
        { name: entity.name, capability: `schema:valibot:${entity.name}:type` },
      ]);

      const enumDeclarations = enums.flatMap(entity =>
        buildEnumDeclarations(entity, "schema:valibot"),
      );

      const tableDeclarations = tables.flatMap(entity =>
        buildShapeDeclarations(entity, "schema:valibot"),
      );

      return [
        ...domainDeclarations,
        ...enumDeclarations,
        ...tableDeclarations,
        buildSchemaBuilderDeclaration("valibotSchemaBuilder", "schema:valibot"),
      ];
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const { enums, domains, tables } = classifyEntities(ir.entities.values());

      // Helper to render enum entities
      const renderEnum = (entity: EnumEntity): RenderedSymbol[] => {
        const schemaNode = conjure
          .id("v")
          .method("picklist", [conjure.arr(...entity.values.map(v => conjure.str(v))).build()])
          .build();
        const schemaDecl = conjure.export.const(entity.name, schemaNode);
        const inferType = conjure.ts.qualifiedRef("v", "InferOutput", [conjure.ts.typeof(entity.name)]);
        const typeDecl = conjure.export.type(entity.name, inferType);

        return [
          {
            name: entity.name,
            capability: `schema:valibot:${entity.name}`,
            node: schemaDecl,
            exports: "named",
            imports: [valibotImport],
            metadata: { consume: createValibotConsumeCallback(entity.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: entity.name,
                capability: `schema:valibot:${entity.name}:type`,
                node: typeDecl,
                exports: "named" as const,
                imports: [valibotImport],
              }]
            : []),
        ];
      };

      // Helper to render domain entities
      const renderDomain = (domain: DomainEntity): RenderedSymbol[] => {
        const schemaNode = domainToValibotSchema(domain);
        const schemaDecl = conjure.export.const(domain.name, schemaNode);
        const inferType = conjure.ts.qualifiedRef("v", "InferOutput", [conjure.ts.typeof(domain.name)]);
        const typeDecl = conjure.export.type(domain.name, inferType);

        return [
          {
            name: domain.name,
            capability: `schema:valibot:${domain.name}`,
            node: schemaDecl,
            exports: "named",
            imports: [valibotImport],
            metadata: { consume: createValibotConsumeCallback(domain.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: domain.name,
                capability: `schema:valibot:${domain.name}:type`,
                node: typeDecl,
                exports: "named" as const,
                imports: [valibotImport],
              }]
            : []),
        ];
      };

      // Helper to render a shape
      const renderShape = (shape: NonNullable<(typeof tables)[number]["shapes"]["row"]>): RenderedSymbol[] => {
        const capability = `schema:valibot:${shape.name}`;
        const schemaNode = registry.forSymbol(capability, () =>
          shapeToValibotObject(shape, enums, domains, registry),
        );
        const schemaDecl = conjure.export.const(shape.name, schemaNode);

        return [
          {
            name: shape.name,
            capability,
            node: schemaDecl,
            exports: "named",
            imports: [valibotImport],
            metadata: { consume: createValibotConsumeCallback(shape.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: shape.name,
                capability: `schema:valibot:${shape.name}:type`,
                node: conjure.export.type(
                  shape.name,
                  conjure.ts.qualifiedRef("v", "InferOutput", [conjure.ts.typeof(shape.name)]),
                ),
                exports: "named" as const,
                imports: [valibotImport],
              }]
            : []),
        ];
      };

      // Schema builder symbol (virtual - no node, just metadata)
      const builderSymbol: RenderedSymbol = {
        name: "valibotSchemaBuilder",
        capability: "schema:valibot:builder",
        node: null,
        exports: false,
        metadata: { builder: valibotSchemaBuilder },
      };

      return [
        ...enums.flatMap(renderEnum),
        ...domains.flatMap(renderDomain),
        ...tables.flatMap(entity => getEntityShapes(entity).flatMap(renderShape)),
        builderSymbol,
      ];
    }),
  };
}
