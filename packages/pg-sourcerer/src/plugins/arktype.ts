/**
 * ArkType Plugin - Generates ArkType schemas for entities
 *
 * Generates ArkType schemas for Row, Insert, Update, and Patch shapes,
 * with optional inferred TypeScript types.
 *
 * Capabilities provided:
 * - `schema:arktype:EntityName` for each table entity (Row schema)
 * - `schema:arktype:EntityName:insert` for Insert shape
 * - `schema:arktype:EntityName:update` for Update shape
 * - `schema:arktype:EnumName` for enum entities
 */
import { Effect, Match, Schema as S, pipe, Array as Arr } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, RenderedSymbol } from "../runtime/types.js";
import { normalizeFileNaming, type FileNaming } from "../runtime/file-assignment.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { IR } from "../services/ir.js";
import { IRExtensions } from "../services/ir-extensions.js";
import { Conjure } from "../services/conjure.js";
import type {
  TableEntity,
  Field,
  EnumEntity,
  DomainEntity,
  CheckConstraint,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import {
  SCHEMA_BUILDER_KEY,
  type SchemaBuilder,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import {
  pgStringTypes,
  pgNumberTypes,
  pgBooleanTypes,
  pgDateTypes,
  pgJsonTypes,
  resolveFieldTypeInfo,
} from "./shared/pg-types.js";
import { parseCheckConstraint, type ConstraintValidation } from "../lib/check-constraint-parser.js";
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

const { b } = conjure;

/**
 * Creates a consume callback for ArkType schemas.
 * Generates: `SchemaName.assert(input)` (throws on validation error)
 *
 * @param schemaName - The name of the ArkType schema
 * @returns A function that generates assert AST for an input expression
 */
function createArkTypeConsumeCallback(schemaName: string): (input: unknown) => n.Expression {
  return (input: unknown) => {
    return conjure
      .id(schemaName)
      .method("assert", [cast.toExpr(input as n.Expression)])
      .build();
  };
}

/**
 * Convert a param type to an ArkType type string.
 */
function paramToArkTypeString(param: { type: string; required: boolean }): string {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();

  const arkType = Match.value(baseType).pipe(
    Match.whenOr("number", "int", "integer", "float", "double", () => "number"),
    Match.whenOr("boolean", "bool", () => "boolean"),
    Match.when("date", () => "Date"),
    Match.orElse(() => "string"),
  );

  return param.required ? arkType : `${arkType}?`;
}

/**
 * ArkType SchemaBuilder implementation.
 * Builds ArkType schemas for path/query parameters.
 */
const arkTypeSchemaBuilder: SchemaBuilder = {
  build(request: SchemaBuilderRequest): SchemaBuilderResult | undefined {
    if (request.params.length === 0) {
      return undefined;
    }

    // Build type({ field: "string", ... }) using reduce
    const objBuilder = request.params.reduce(
      (builder, param) => builder.prop(param.name, conjure.str(paramToArkTypeString(param))),
      conjure.obj(),
    );

    const ast = conjure.id("type").call([objBuilder.build()]).build();
    const consume = (input: n.Expression) =>
      b.callExpression(b.memberExpression(cast.toExpr(ast), b.identifier("assert")), [
        cast.toExpr(input),
      ]);

    return {
      ast,
      importSpec: { from: "arktype", names: ["type"] },
      consume,
    };
  },
};

const ArkTypeSchemaConfig = S.Struct({
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
});

/** Schema-validated config options */
type SchemaConfig = S.Schema.Type<typeof ArkTypeSchemaConfig>;

/**
 * ArkType plugin configuration.
 *
 * @example
 * // Basic usage - all schemas in schemas.ts
 * arktype()
 *
 * @example
 * // Per-entity schema files
 * arktype({
 *   schemasFile: ({ entityName }) => `${entityName.toLowerCase()}/schemas.ts`,
 * })
 */
export interface ArkTypeConfig {
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
interface ResolvedArkTypeConfig extends SchemaConfig {
  schemasFile: FileNaming;
}

// =============================================================================
// PostgreSQL Type to ArkType String Mapping
// =============================================================================

/**
 * Result of mapping a field to ArkType.
 * - `typeString`: ArkType string type (e.g., "string", "number", "string.uuid")
 * - `enumRef`: Reference to a separately defined enum schema
 */
type ArkTypeMapping =
  | { kind: "string"; typeString: string; enumRef?: undefined; domainRef?: undefined }
  | { kind: "enumRef"; enumRef: string; typeString?: undefined; domainRef?: undefined }
  | { kind: "domainRef"; domainRef: string; typeString?: undefined; enumRef?: undefined };

function fieldToArkType(
  field: Field,
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  checkConstraints: readonly CheckConstraint[] = [],
): ArkTypeMapping {
  const resolved = resolveFieldTypeInfo(field);
  if (!resolved) {
    return { kind: "string", typeString: "unknown" };
  }
  const baseResult = baseTypeToArkType(resolved.typeName, resolved.typeInfo, enums, domains);

  // For enum and domain references, we can't easily add modifiers in string form,
  // so we handle them specially in shapeToArkTypeObject
  if (baseResult.kind === "enumRef" || baseResult.kind === "domainRef") {
    return baseResult;
  }

  const fieldConstraints = checkConstraints.filter(c => c.columns.includes(field.columnName));

  const constraints = fieldConstraints.flatMap(c =>
    parseCheckConstraint(c.definition, field.columnName),
  );

  const constrainedType = applyConstraintsToArkTypeString(baseResult.typeString, constraints);

  const typeStr = pipe(
    constrainedType,
    s => (field.isArray ? `${s}[]` : s),
    s => (field.nullable ? `${s} | null` : s),
    s => (field.optional ? `${s}?` : s),
  );

  return { kind: "string", typeString: typeStr };
}

function applyConstraintsToArkTypeString(
  baseType: string,
  constraints: readonly ConstraintValidation[],
): string {
  const toRegexRefinement = (pattern: string, flags?: string): string => {
    const escapedPattern = pattern.replace(/\//g, "\\/");
    return `/${escapedPattern}/${flags ?? ""}`;
  };

  const { bounds, refinements } = constraints.reduce(
    (acc, validation) =>
      Match.value(validation).pipe(
        Match.when({ kind: "minLength" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `>= ${v.value}`],
        })),
        Match.when({ kind: "maxLength" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `<= ${v.value}`],
        })),
        Match.when({ kind: "lengthRange" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `>= ${v.min}`, `<= ${v.max}`],
        })),
        Match.when({ kind: "min" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `>= ${v.value}`],
        })),
        Match.when({ kind: "max" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `<= ${v.value}`],
        })),
        Match.when({ kind: "range" }, v => ({
          ...acc,
          bounds: [...acc.bounds, `>= ${v.min}`, `<= ${v.max}`],
        })),
        Match.when({ kind: "regex" }, v => ({
          ...acc,
          refinements: [...acc.refinements, toRegexRefinement(v.pattern, v.flags)],
        })),
        Match.orElse(() => acc),
      ),
    { bounds: [] as string[], refinements: [] as string[] },
  );

  const withBounds = bounds.length > 0 ? `${baseType} ${bounds.join(" ")}` : baseType;

  return refinements.length > 0
    ? `${withBounds} & ${refinements.join(" & ")}`
    : withBounds;
}

function baseTypeToArkType(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
): ArkTypeMapping {
  const normalized = typeName.toLowerCase();

  if (pgStringTypes.has(normalized)) {
    if (normalized === "uuid") {
      return { kind: "string", typeString: "string.uuid" };
    }
    // citext is case-insensitive text, but ArkType doesn't have a specific validator
    // Just treat it as a regular string
    return { kind: "string", typeString: "string" };
  }

  if (pgNumberTypes.has(normalized)) {
    return { kind: "string", typeString: "number" };
  }

  if (pgBooleanTypes.has(normalized)) {
    return { kind: "string", typeString: "boolean" };
  }

  if (pgDateTypes.has(normalized)) {
    return { kind: "string", typeString: "Date" };
  }

  if (pgJsonTypes.has(normalized)) {
    return { kind: "string", typeString: "unknown" };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      // Return reference to the enum schema instead of inlining
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "string", typeString: "unknown" };
  }

  // Check for domain types
  if (pgType.typtype === "d") {
    const domainEntity = domains.find(d => d.pgType.typname === typeName);
    if (domainEntity) {
      return { kind: "domainRef", domainRef: domainEntity.name };
    }
    return { kind: "string", typeString: "unknown" };
  }

  return { kind: "string", typeString: "unknown" };
}

// =============================================================================
// Shape to ArkType Object
// =============================================================================

function shapeToArkTypeObject(
  shape: { fields: readonly Field[] },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  registry: SymbolRegistryService,
  checkConstraints: readonly CheckConstraint[] = [],
): n.Expression {
  // Apply nullable modifier to an expression
  const applyNullable = (expr: n.Expression): n.Expression =>
    conjure
      .chain(expr)
      .method("or", [conjure.id("type").call([conjure.str("null")]).build()])
      .build();

  // Apply array modifier to an expression
  const applyArray = (expr: n.Expression): n.Expression =>
    conjure.chain(expr).method("array").build();

  // Build property value for a field
  const buildFieldValue = (field: Field): n.Expression => {
    const mapping = fieldToArkType(field, enums, domains, checkConstraints);

    if (mapping.kind === "enumRef" || mapping.kind === "domainRef") {
      const capability = mapping.kind === "enumRef"
        ? `schema:arktype:${mapping.enumRef}`
        : `schema:arktype:${mapping.domainRef}`;
      const handle = registry.import(capability);
      const baseExpr = handle.ref() as n.Expression;

      const withArray = field.isArray ? applyArray(baseExpr) : baseExpr;
      return field.nullable ? applyNullable(withArray) : withArray;
    }

    return conjure.str(mapping.typeString!);
  };

  const objBuilder = shape.fields.reduce(
    (builder, field) => builder.prop(field.name, buildFieldValue(field)),
    conjure.obj(),
  );

  return conjure.id("type").call([objBuilder.build()]).build();
}

function shapeToArkTypeSubsetFromRow(
  shape: NonNullable<TableEntity["shapes"]["row"]>,
  baseEntityName: string,
  registry: SymbolRegistryService,
): n.Expression | null {
  if (shape.kind === "row" || shape.fields.length === 0) {
    return null;
  }

  const rowCapability = `schema:arktype:${baseEntityName}`;
  if (!registry.has(rowCapability)) {
    return null;
  }

  const rowHandle = registry.import(rowCapability);
  const picked = b.callExpression(
    b.memberExpression(cast.toExpr(rowHandle.ref() as n.Expression), b.identifier("pick")),
    shape.fields.map(field => b.stringLiteral(field.name)),
  );

  const optionalFields = shape.fields.filter(field => field.optional);
  if (optionalFields.length === 0) {
    return picked;
  }

  if (optionalFields.length === shape.fields.length) {
    return b.callExpression(
      b.memberExpression(picked, b.identifier("partial")),
      [],
    );
  }

  return b.callExpression(
    b.memberExpression(picked, b.identifier("partial")),
    optionalFields.map(field => b.stringLiteral(field.name)),
  );
}

/**
 * Convert a domain entity to an arktype schema string.
 * Applies constraints from the domain definition.
 */
function domainToArktypeString(domain: DomainEntity): string {
  const baseType = domain.baseTypeName.toLowerCase();

  // Get base type
  const baseSchema = pgStringTypes.has(baseType)
    ? "string"
    : pgNumberTypes.has(baseType)
      ? "number"
      : pgBooleanTypes.has(baseType)
        ? "boolean"
        : pgDateTypes.has(baseType)
          ? "Date"
          : "unknown";

  // Extract all validations from constraints
  const validations = domain.constraints.flatMap(c => c.validations);

  // Process validations into constraint strings and length bounds
  type Accumulator = { constraints: string[]; minLen: number | null; maxLen: number | null };

  const { constraints, minLen, maxLen } = validations.reduce<Accumulator>(
    (acc, validation) =>
      Match.value(validation).pipe(
        Match.when({ kind: "minLength" }, v => ({ ...acc, minLen: v.value })),
        Match.when({ kind: "maxLength" }, v => ({ ...acc, maxLen: v.value })),
        Match.when({ kind: "min" }, v => ({
          ...acc,
          constraints: [...acc.constraints, `>= ${v.value}`],
        })),
        Match.when({ kind: "max" }, v => ({
          ...acc,
          constraints: [...acc.constraints, `<= ${v.value}`],
        })),
        Match.when({ kind: "regex" }, v => {
          const escapedPattern = v.pattern.replace(/\//g, "\\/");
          const flags = v.caseInsensitive ? "i" : "";
          return {
            ...acc,
            constraints: [...acc.constraints, `/${escapedPattern}/${flags}`],
          };
        }),
        Match.orElse(() => acc),
      ),
    { constraints: [], minLen: null, maxLen: null },
  );

  // Apply string length constraints
  const withLength =
    minLen !== null && maxLen !== null
      ? `${baseSchema} >= ${minLen} <= ${maxLen}`
      : minLen !== null
        ? `${baseSchema} >= ${minLen}`
        : maxLen !== null
          ? `${baseSchema} <= ${maxLen}`
          : baseSchema;

  // Combine with other constraints
  return constraints.length > 0
    ? `${withLength} & ${constraints.join(" & ")}`
    : withLength;
}

// =============================================================================
// ArkType Plugin Definition
// =============================================================================

export function arktype(config?: ArkTypeConfig): Plugin {
  const schemaConfig = S.decodeSync(ArkTypeSchemaConfig)(config ?? {});

  const resolvedConfig: ResolvedArkTypeConfig = {
    ...schemaConfig,
    schemasFile: normalizeFileNaming(config?.schemasFile, "schemas.ts"),
  };

  return {
    name: "arktype",

    provides: ["schema"],

    fileDefaults: [
      {
        pattern: "schema:",
        fileNaming: resolvedConfig.schemasFile,
      },
    ],

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const cj = yield* Conjure;
      const extensions = yield* IRExtensions;
      const { enums, domains, tables } = classifyEntities(ir.entities.values());

      const arktypeImport = { from: "arktype", names: ["type"] } as const;

      // Render domain entity
      const renderDomain = (entity: DomainEntity) =>
        Effect.gen(function* () {
          const schemaString = domainToArktypeString(entity);
          const schemaInit = conjure.id("type").call([conjure.str(schemaString)]).build();

          const schemaStmt = yield* cj.exp.const(entity.name, schemaInit, {
            capability: `schema:arktype:${entity.name}`,
            imports: [arktypeImport],
            consume: createArkTypeConsumeCallback(entity.name),
            baseEntityName: entity.name,
          });

          const stmts = [schemaStmt];

          if (resolvedConfig.exportTypes) {
            const inferType = conjure.ts.typeof(`${entity.name}.infer`);
            const typeStmt = yield* cj.exp.type(entity.name, inferType, {
              capability: `schema:arktype:${entity.name}:type`,
              imports: [arktypeImport],
              baseEntityName: entity.name,
            });
            stmts.push(typeStmt);
          }

          return stmts;
        });

      // Render enum entity
      const renderEnum = (entity: EnumEntity) =>
        Effect.gen(function* () {
          const enumString = entity.values.map(v => `'${v}'`).join(" | ");
          const schemaInit = conjure.id("type").call([conjure.str(enumString)]).build();

          const schemaStmt = yield* cj.exp.const(entity.name, schemaInit, {
            capability: `schema:arktype:${entity.name}`,
            imports: [arktypeImport],
            consume: createArkTypeConsumeCallback(entity.name),
            baseEntityName: entity.name,
          });

          const stmts = [schemaStmt];

          if (resolvedConfig.exportTypes) {
            const inferType = conjure.ts.typeof(`${entity.name}.infer`);
            const typeStmt = yield* cj.exp.type(entity.name, inferType, {
              capability: `schema:arktype:${entity.name}:type`,
              imports: [arktypeImport],
              baseEntityName: entity.name,
            });
            stmts.push(typeStmt);
          }

          return stmts;
        });

      // Render a shape (row, insert, update) with baseEntityName from parent entity
      const renderShape = (
        shape: NonNullable<TableEntity["shapes"]["row"]>,
        baseEntityName: string,
        checkConstraints: readonly CheckConstraint[],
      ) =>
        Effect.gen(function* () {
          const capability = `schema:arktype:${shape.name}`;
          const schemaInit = registry.forSymbol(capability, () => {
            const subset = shapeToArkTypeSubsetFromRow(shape, baseEntityName, registry);
            if (subset) return subset;
            return shapeToArkTypeObject(shape, enums, domains, registry, checkConstraints);
          });

          const schemaStmt = yield* cj.exp.const(shape.name, schemaInit, {
            capability,
            imports: [arktypeImport],
            consume: createArkTypeConsumeCallback(shape.name),
            baseEntityName,
          });

          const stmts = [schemaStmt];

          if (resolvedConfig.exportTypes) {
            const inferType = conjure.ts.typeof(`${shape.name}.infer`);
            const typeStmt = yield* cj.exp.type(shape.name, inferType, {
              capability: `schema:arktype:${shape.name}:type`,
              imports: [arktypeImport],
              baseEntityName,
            });
            stmts.push(typeStmt);
          }

          return stmts;
        });

      // Render table entity shapes
      const renderTable = (entity: TableEntity) =>
        Effect.gen(function* () {
          const shapeStmts = yield* Effect.forEach(
            getEntityShapes(entity),
            shape => renderShape(shape, entity.name, entity.checkConstraints),
          );
          return Arr.flatten(shapeStmts);
        });

      // Register schema builder with IRExtensions
      extensions.set(SCHEMA_BUILDER_KEY, arkTypeSchemaBuilder);

      // Order matters: enums first (no deps), then domains (may ref enums), then tables (may ref both)
      const enumStmts = yield* Effect.forEach(enums, renderEnum);
      const domainStmts = yield* Effect.forEach(domains, renderDomain);
      const tableStmts = yield* Effect.forEach(tables, renderTable);

      return [...Arr.flatten(enumStmts), ...Arr.flatten(domainStmts), ...Arr.flatten(tableStmts)];
    }),
  };
}
