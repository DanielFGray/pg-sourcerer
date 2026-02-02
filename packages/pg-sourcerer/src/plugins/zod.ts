/**
 * Zod Plugin - Generates Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with optional inferred TypeScript types.
 *
 * Capabilities provided:
 * - `schema:zod:EntityName` for each table entity (Row schema)
 * - `schema:zod:EntityName:insert` for Insert shape
 * - `schema:zod:EntityName:update` for Update shape
 * - `schema:zod:EnumName` for enum entities
 */
import { Effect, Match, Schema as S, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { IR } from "../services/ir.js";
import type { Field, EnumEntity, DomainEntity } from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import type {
  SchemaBuilder,
  SchemaBuilderRequest,
  SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import {
  pgStringTypes,
  pgNumberTypes,
  pgBooleanTypes,
  pgDateTypes,
  pgJsonTypes,
  resolveFieldTypeInfo,
} from "./shared/pg-types.js";
import { parseCheckConstraint } from "../lib/check-constraint-parser.js";
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

/**
 * Creates a consume callback for Zod schemas.
 * Generates: `SchemaName.parse(input)`
 *
 * @param schemaName - The name of the Zod schema
 * @returns A function that generates parse AST for an input expression
 */
function createZodConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure
      .id(schemaName)
      .method("parse", [cast.toExpr(input as n.Expression)])
      .build();
  };
}
const zodImport = { from: "zod", names: ["z"] };
/**
 * Zod SchemaBuilder implementation.
 * Builds Zod schemas for path/query parameters.
 */
const zodSchemaBuilder: SchemaBuilder = {
  build(request: SchemaBuilderRequest): SchemaBuilderResult | undefined {
    if (request.params.length === 0) {
      return undefined;
    }

    // Build z.object({ field: z.type(), ... })
    const objBuilder = request.params.reduce(
      (builder, param) => builder.prop(param.name, paramToZodType(param)),
      conjure.obj(),
    );

    const ast = conjure.id("z").method("object", [objBuilder.build()]).build();
    const consume = (input: n.Expression) =>
      b.callExpression(b.memberExpression(cast.toExpr(ast), b.identifier("parse")), [
        cast.toExpr(input),
      ]);

    return {
      ast,
      importSpec: zodImport,
      consume,
    };
  },
};

/**
 * Convert a QueryMethodParam to a Zod type expression.
 */
function paramToZodType(param: { type: string; required: boolean }): n.Expression {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  const baseChain = Match.value(baseType).pipe(
    Match.whenOr("number", "int", "integer", "float", "double", () =>
      conjure.id("z").prop("coerce").method("number"),
    ),
    Match.whenOr("boolean", "bool", () => conjure.id("z").method("boolean")),
    Match.when("date", () => conjure.id("z").prop("coerce").method("date")),
    Match.orElse(() => conjure.id("z").method("string")),
  );

  return param.required ? baseChain.build() : baseChain.method("optional").build();
}

const b = conjure.b;

const ZodSchemaConfig = S.Struct({
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof ZodSchemaConfig>;

/**
 * Zod plugin configuration.
 *
 * @example
 * // Basic usage - all schemas in schemas.ts
 * zod()
 *
 * @example
 * // Per-entity schema files
 * zod({
 *   schemasFile: ({ entityName }) => `${entityName.toLowerCase()}/schemas.ts`,
 * })
 */
export interface ZodConfig {
  /** Export inferred TypeScript types alongside schemas (default: true) */
  exportTypes?: boolean;
  /**
   * Output file path for schemas.
   * Can be a string (static path) or function (dynamic per entity).
   * @default "schemas.ts"
   */
  schemasFile?: string | FileNaming;
}

/** Resolved config with defaults applied */
interface ResolvedZodConfig extends SchemaConfig {
  schemasFile: FileNaming;
}

function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind;
}

// =============================================================================
// PostgreSQL Type to Zod Schema Mapping
// =============================================================================

/**
 * Result of mapping a field to Zod.
 * - `schema`: Zod schema expression (e.g., z.string(), z.number())
 * - `enumRef`: Reference to a separately defined enum schema
 * - `domainRef`: Reference to a separately defined domain schema
 */
type ZodMapping =
  | { kind: "schema"; schema: n.Expression; enumRef?: undefined; domainRef?: undefined }
  | { kind: "enumRef"; enumRef: string; schema?: undefined; domainRef?: undefined }
  | { kind: "domainRef"; domainRef: string; schema?: undefined; enumRef?: undefined };

function fieldToZodMapping(
  field: Field,
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  checkConstraints: readonly import("../ir/semantic-ir.js").CheckConstraint[] = [],
): ZodMapping {
  const resolved = resolveFieldTypeInfo(field);
  if (!resolved) {
    return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
  }
  const baseResult = baseTypeToZodMapping(resolved.typeName, resolved.typeInfo, enums, domains);

  // For enum references, return as-is (modifiers applied in shapeToZodObject)
  if (baseResult.kind === "enumRef") {
    return baseResult;
  }

  // For domain references, return as-is (modifiers applied in shapeToZodObject)
  if (baseResult.kind === "domainRef") {
    return baseResult;
  }

  // Apply column-level CHECK constraints
  const fieldConstraints = checkConstraints.filter(c => c.columns.includes(field.columnName));

  const applyValidation = (schema: n.Expression, validation: ReturnType<typeof parseCheckConstraint>[number]): n.Expression =>
    Match.value(validation).pipe(
      Match.when({ kind: "minLength" }, v => conjure.chain(schema).method("min", [conjure.num(v.value)]).build()),
      Match.when({ kind: "min" }, v => conjure.chain(schema).method("min", [conjure.num(v.value)]).build()),
      Match.when({ kind: "maxLength" }, v => conjure.chain(schema).method("max", [conjure.num(v.value)]).build()),
      Match.when({ kind: "max" }, v => conjure.chain(schema).method("max", [conjure.num(v.value)]).build()),
      Match.when({ kind: "regex" }, v => conjure.chain(schema).method("regex", [conjure.regex(v.pattern, v.flags ?? "")]).build()),
      Match.orElse(() => schema),
    );

  const withConstraints = fieldConstraints.reduce(
    (currentSchema, constraint) =>
      parseCheckConstraint(constraint.definition, field.columnName).reduce(applyValidation, currentSchema),
    baseResult.schema,
  );

  const withArray = field.isArray
    ? conjure.chain(withConstraints).method("array").build()
    : withConstraints;

  const modifiers = [
    field.nullable && "nullable",
    field.optional && "optional",
  ].filter(Boolean) as string[];

  const schema = modifiers.reduce(
    (s, method) => conjure.chain(s).method(method).build(),
    withArray,
  );

  return { kind: "schema", schema };
}

function baseTypeToZodMapping(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
): ZodMapping {
  const normalized = typeName.toLowerCase();

  // Check if this is a domain type
  if (pgType.typtype === "d") {
    const domainEntity = domains.find(d => d.pgType.typname === typeName);
    if (domainEntity) {
      // Return reference to the domain schema instead of inlining
      return { kind: "domainRef", domainRef: domainEntity.name };
    }
    // If domain entity not found, fall through to handle base type
  }

  if (pgStringTypes.has(normalized)) {
    if (normalized === "uuid") {
      return { kind: "schema", schema: conjure.id("z").method("uuid").build() };
    }
    // citext is case-insensitive text - just treat as regular string
    // (Zod doesn't have a built-in case-insensitive string validator)
    return { kind: "schema", schema: conjure.id("z").method("string").build() };
  }

  if (pgNumberTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("number").build() };
  }

  if (pgBooleanTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("boolean").build() };
  }

  if (pgDateTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").prop("coerce").method("date").build() };
  }

  if (pgJsonTypes.has(normalized)) {
    return { kind: "schema", schema: conjure.id("z").method("any").build() };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      // Return reference to the enum schema instead of inlining
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
  }

  return { kind: "schema", schema: conjure.id("z").method("unknown").build() };
}

// Zod-specific adapters for shared helpers
const zodBaseTypeAdapter: BaseTypeAdapter<n.Expression> = {
  string: () => conjure.id("z").method("string").build(),
  uuid: () => conjure.id("z").method("uuid").build(),
  number: () => conjure.id("z").method("number").build(),
  boolean: () => conjure.id("z").method("boolean").build(),
  date: () => conjure.id("z").prop("coerce").method("date").build(),
  json: () => conjure.id("z").method("any").build(),
  unknown: () => conjure.id("z").method("unknown").build(),
};

const zodValidationAdapter: ValidationAdapter<n.Expression> = {
  minLength: (s, v) => conjure.chain(s).method("min", [conjure.num(v)]).build(),
  maxLength: (s, v) => conjure.chain(s).method("max", [conjure.num(v)]).build(),
  min: (s, v) => conjure.chain(s).method("min", [conjure.num(v)]).build(),
  max: (s, v) => conjure.chain(s).method("max", [conjure.num(v)]).build(),
  regex: (s, p, f) => conjure.chain(s).method("regex", [conjure.regex(p, f ?? "")]).build(),
};

const zodModifierAdapter: ModifierAdapter<n.Expression> = {
  array: s => conjure.chain(s).method("array").build(),
  nullable: s => conjure.chain(s).method("nullable").build(),
  optional: s => conjure.chain(s).method("optional").build(),
};

function domainToZodSchema(domain: DomainEntity): n.Expression {
  const baseSchema = domainBaseSchema(domain, zodBaseTypeAdapter);
  return applyDomainValidations(baseSchema, domain, zodValidationAdapter);
}

// =============================================================================
// Shape to Zod Object
// =============================================================================

/** Apply Zod modifiers (array, nullable, optional) to a base expression */
const applyZodModifiers = (base: n.Expression, field: Field): n.Expression =>
  applyModifiers(base, field, zodModifierAdapter);

function shapeToZodObject(
  shape: { fields: readonly Field[] },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  registry: SymbolRegistryService,
  checkConstraints: readonly import("../ir/semantic-ir.js").CheckConstraint[] = [],
): n.Expression {
  const properties = shape.fields.map(field => {
    const mapping = fieldToZodMapping(field, enums, domains, checkConstraints);

    const value: n.Expression = pipe(
      Match.value(mapping.kind),
      Match.when("enumRef", () => {
        const enumHandle = registry.import(`schema:zod:${mapping.enumRef}`);
        return applyZodModifiers(enumHandle.ref() as n.Expression, field);
      }),
      Match.when("domainRef", () => {
        const domainHandle = registry.import(`schema:zod:${mapping.domainRef}`);
        return applyZodModifiers(domainHandle.ref() as n.Expression, field);
      }),
      Match.orElse(() => mapping.schema!),
    );

    return b.objectProperty(b.identifier(field.name), toExpr(value));
  });

  const objExpr = b.objectExpression(properties);
  const zObject = b.callExpression(b.memberExpression(b.identifier("z"), b.identifier("object")), [
    objExpr,
  ]);
  return zObject;
}

// =============================================================================
// Zod Plugin Definition
// =============================================================================

export function zod(config?: ZodConfig): Plugin {
  // Parse schema-validated options
  const schemaConfig = S.decodeSync(ZodSchemaConfig)(config ?? {});

  // Resolve file naming
  const resolvedConfig: ResolvedZodConfig = {
    ...schemaConfig,
    schemasFile: normalizeFileNaming(config?.schemasFile, "schemas.ts"),
  };

  return {
    name: "zod",

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

      // Domains - use domain name directly (e.g., "Url", not "UrlSchema")
      const domainDeclarations = domains.flatMap(domain => [
        { name: domain.name, capability: `schema:zod:${domain.name}` },
        { name: domain.name, capability: `schema:zod:${domain.name}:type` },
      ]);

      const enumDeclarations = enums.flatMap(entity =>
        buildEnumDeclarations(entity, "schema:zod"),
      );

      const tableDeclarations = tables.flatMap(entity =>
        buildShapeDeclarations(entity, "schema:zod"),
      );

      return [
        ...domainDeclarations,
        ...enumDeclarations,
        ...tableDeclarations,
        buildSchemaBuilderDeclaration("zodSchemaBuilder", "schema:zod"),
      ];
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const { enums, domains, tables } = classifyEntities(ir.entities.values());

      // Helper to render enum entities
      const renderEnum = (entity: EnumEntity): RenderedSymbol[] => {
        const enumArray = conjure.asConst(
          conjure.arr(...entity.values.map(v => conjure.str(v))).build(),
        );
        const schemaNode = conjure.id("z").method("enum", [enumArray]).build();
        const schemaDecl = conjure.export.const(entity.name, schemaNode);
        const inferType = conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof(entity.name)]);
        const typeDecl = conjure.export.type(entity.name, inferType);

        return [
          {
            name: entity.name,
            capability: `schema:zod:${entity.name}`,
            node: schemaDecl,
            exports: "named",
            imports: [zodImport],
            metadata: { consume: createZodConsumeCallback(entity.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: entity.name,
                capability: `schema:zod:${entity.name}:type`,
                node: typeDecl,
                exports: "named" as const,
                imports: [zodImport],
              }]
            : []),
        ];
      };

      // Helper to render domain entities
      const renderDomain = (domain: DomainEntity): RenderedSymbol[] => {
        const schemaNode = domainToZodSchema(domain);
        const schemaDecl = conjure.export.const(domain.name, schemaNode);
        const inferType = conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof(domain.name)]);
        const typeDecl = conjure.export.type(domain.name, inferType);

        return [
          {
            name: domain.name,
            capability: `schema:zod:${domain.name}`,
            node: schemaDecl,
            exports: "named",
            imports: [zodImport],
            metadata: { consume: createZodConsumeCallback(domain.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: domain.name,
                capability: `schema:zod:${domain.name}:type`,
                node: typeDecl,
                exports: "named" as const,
                imports: [zodImport],
              }]
            : []),
        ];
      };

      // Helper to render a shape
      const renderShape = (shape: NonNullable<(typeof tables)[number]["shapes"]["row"]>): RenderedSymbol[] => {
        const capability = `schema:zod:${shape.name}`;
        const schemaNode = registry.forSymbol(capability, () =>
          shapeToZodObject(shape, [...enums], [...domains], registry),
        );
        const schemaDecl = conjure.export.const(shape.name, schemaNode);

        return [
          {
            name: shape.name,
            capability,
            node: schemaDecl,
            exports: "named",
            imports: [zodImport],
            metadata: { consume: createZodConsumeCallback(shape.name) },
          },
          ...(resolvedConfig.exportTypes
            ? [{
                name: shape.name,
                capability: `schema:zod:${shape.name}:type`,
                node: conjure.export.type(
                  shape.name,
                  conjure.ts.qualifiedRef("z", "infer", [conjure.ts.typeof(shape.name)]),
                ),
                exports: "named" as const,
                imports: [zodImport],
              }]
            : []),
        ];
      };

      // Schema builder symbol (virtual - no node, just metadata)
      const builderSymbol: RenderedSymbol = {
        name: "zodSchemaBuilder",
        capability: "schema:zod:builder",
        node: null,
        exports: false,
        metadata: { builder: zodSchemaBuilder },
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
