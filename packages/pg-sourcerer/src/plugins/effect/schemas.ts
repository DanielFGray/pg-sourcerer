/**
 * Effect Schemas Plugin
 *
 * Generates Effect Schema definitions for enum, domain, and table entities.
 * Table schemas use S.Struct({...}) with field type mapping, enum/domain refs,
 * and optional inferred type aliases.
 */
import { Effect, Match, Array as Arr, pipe } from "effect";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";

import type { Plugin, SymbolDeclaration } from "../../runtime/types.js";
import { SymbolRegistry, type SymbolRegistryService } from "../../runtime/registry.js";
import { IR } from "../../services/ir.js";
import { Conjure } from "../../services/conjure.js";
import {
  isEnumEntity,
  isDomainEntity,
  isTableEntity,
  type EnumEntity,
  type DomainEntity,
  type TableEntity,
  type Field,
  type CheckConstraint,
} from "../../ir/semantic-ir.js";
import { conjure, cast } from "../../conjure/index.js";
import { fieldToEffectMapping, buildModifierPipeArgs, withPipe, type ParsedEffectConfig } from "./shared.js";
import {
  pgStringTypes,
  pgNumberTypes,
  pgBooleanTypes,
  pgDateTypes,
  pgJsonTypes,
} from "../shared/pg-types.js";
import { classifyEntities, getEntityShapes } from "../shared/schema-entities.js";
import { parseCheckConstraint, type ConstraintValidation } from "../../lib/check-constraint-parser.js";

const effectSchemaImports = [{ from: "effect", names: ["Schema as S"] }];

/**
 * Build the enum schema expression: S.Union(S.Literal("a"), S.Literal("b"), ...)
 */
const buildEnumSchemaExpr = (entity: EnumEntity): n.Expression => {
  const literals = entity.values.map(v =>
    conjure.id("S").method("Literal", [conjure.str(v)]).build(),
  );
  return conjure.id("S").method("Union", literals).build();
};

/**
 * Build the inferred type: S.Schema.Type<typeof EnumName>
 */
const buildInferredType = (entityName: string): n.TSType =>
  conjure.ts.qualifiedRefWithParams(
    ["S", "Schema", "Type"],
    [conjure.ts.typeof(entityName)],
  );

// =============================================================================
// Domain Schema Building
// =============================================================================

/**
 * Get base Effect Schema property for a domain's underlying type.
 */
function domainBaseSchemaExpr(domain: DomainEntity): n.Expression {
  const baseType = domain.baseTypeName.toLowerCase();

  if (pgStringTypes.has(baseType)) {
    return conjure.id("S").prop("String").build();
  }
  if (pgNumberTypes.has(baseType)) {
    return conjure.id("S").prop("Number").build();
  }
  if (pgBooleanTypes.has(baseType)) {
    return conjure.id("S").prop("Boolean").build();
  }
  if (pgDateTypes.has(baseType)) {
    return conjure.id("S").prop("DateFromSelf").build();
  }
  if (pgJsonTypes.has(baseType)) {
    return conjure.id("S").prop("Unknown").build();
  }
  return conjure.id("S").prop("Unknown").build();
}

/**
 * Convert a DomainValidation to an Effect Schema filter expression.
 * Returns null for unknown/unsupported validations.
 */
function domainValidationToFilter(
  validation: DomainEntity["constraints"][number]["validations"][number],
): n.Expression | null {
  return Match.value(validation).pipe(
    Match.when({ kind: "minLength" }, v =>
      conjure.id("S").method("minLength", [conjure.num(v.value)]).build(),
    ),
    Match.when({ kind: "maxLength" }, v =>
      conjure.id("S").method("maxLength", [conjure.num(v.value)]).build(),
    ),
    Match.when({ kind: "min" }, v =>
      conjure.id("S").method("greaterThanOrEqualTo", [conjure.num(v.value)]).build(),
    ),
    Match.when({ kind: "max" }, v =>
      conjure.id("S").method("lessThanOrEqualTo", [conjure.num(v.value)]).build(),
    ),
    Match.when({ kind: "regex" }, v => {
      const flags = v.caseInsensitive ? "i" : "";
      return conjure.id("S").method("pattern", [conjure.regex(v.pattern, flags)]).build();
    }),
    Match.orElse(() => null),
  );
}

/**
 * Build a domain schema expression with constraints applied via .pipe().
 * E.g., S.String.pipe(S.minLength(3), S.maxLength(50), S.pattern(/^[a-z]/))
 */
function buildDomainSchemaExpr(domain: DomainEntity): n.Expression {
  const baseSchema = domainBaseSchemaExpr(domain);

  const filters = domain.constraints
    .flatMap(c => c.validations)
    .map(domainValidationToFilter)
    .filter((f): f is n.Expression => f !== null);

  if (filters.length === 0) {
    return baseSchema;
  }

  return conjure.chain(baseSchema).method("pipe", filters).build();
}

// =============================================================================
// CHECK Constraint Mapping
// =============================================================================

/**
 * Convert a parsed CHECK constraint validation to an Effect Schema filter.
 * Handles all ConstraintValidation kinds from parseCheckConstraint.
 */
function checkValidationToFilter(v: ConstraintValidation): n.Expression[] {
  return Match.value(v).pipe(
    Match.when({ kind: "minLength" }, v => [
      conjure.id("S").method("minLength", [conjure.num(v.value)]).build(),
    ]),
    Match.when({ kind: "maxLength" }, v => [
      conjure.id("S").method("maxLength", [conjure.num(v.value)]).build(),
    ]),
    Match.when({ kind: "lengthRange" }, v => [
      conjure.id("S").method("minLength", [conjure.num(v.min)]).build(),
      conjure.id("S").method("maxLength", [conjure.num(v.max)]).build(),
    ]),
    Match.when({ kind: "min" }, v => [
      conjure.id("S").method("greaterThanOrEqualTo", [conjure.num(v.value)]).build(),
    ]),
    Match.when({ kind: "max" }, v => [
      conjure.id("S").method("lessThanOrEqualTo", [conjure.num(v.value)]).build(),
    ]),
    Match.when({ kind: "range" }, v => [
      conjure.id("S").method("greaterThanOrEqualTo", [conjure.num(v.min)]).build(),
      conjure.id("S").method("lessThanOrEqualTo", [conjure.num(v.max)]).build(),
    ]),
    Match.when({ kind: "regex" }, v => [
      conjure.id("S").method("pattern", [conjure.regex(v.pattern, v.flags ?? "")]).build(),
    ]),
    Match.orElse(() => []),
  );
}

/**
 * Extract CHECK constraint filter expressions for a field.
 */
function getCheckConstraintFilters(
  field: Field,
  checkConstraints: readonly CheckConstraint[],
): n.Expression[] {
  const fieldConstraints = checkConstraints.filter(c =>
    c.columns.includes(field.columnName),
  );

  return fieldConstraints.flatMap(c =>
    parseCheckConstraint(c.definition, field.columnName).flatMap(checkValidationToFilter),
  );
}

// =============================================================================
// Table Schema Building
// =============================================================================

const b = conjure.b;

/**
 * Build S.Struct({ field: S.Type, ... }) for a shape.
 *
 * Uses pipe-style composition: base.pipe(...filters, ...modifiers)
 * e.g. S.String.pipe(S.pattern(/x/), S.NullOr) instead of S.NullOr(S.String).pipe(S.pattern(/x/))
 */
function shapeToEffectStruct(
  shape: { fields: readonly Field[] },
  enums: readonly EnumEntity[],
  domains: readonly DomainEntity[],
  registry: SymbolRegistryService,
  checkConstraints: readonly CheckConstraint[] = [],
): n.Expression {
  const properties = shape.fields.map(field => {
    const mapping = fieldToEffectMapping(field, [...enums], domains);

    const value: n.Expression = pipe(
      Match.value(mapping),
      Match.when({ kind: "enumRef" }, ({ enumRef }) => {
        const handle = registry.import(`effect:schema:${enumRef}`);
        const modifiers = buildModifierPipeArgs(field);
        if (field.optional) modifiers.push(conjure.id("S").prop("optional").build());
        return withPipe(handle.ref() as n.Expression, modifiers);
      }),
      Match.when({ kind: "domainRef" }, ({ domainRef }) => {
        const handle = registry.import(`effect:schema:${domainRef}`);
        const modifiers = buildModifierPipeArgs(field);
        if (field.optional) modifiers.push(conjure.id("S").prop("optional").build());
        return withPipe(handle.ref() as n.Expression, modifiers);
      }),
      Match.when({ kind: "schema" }, ({ schema }) => {
        const filters = getCheckConstraintFilters(field, checkConstraints);
        const modifiers = buildModifierPipeArgs(field);
        return withPipe(schema, [...filters, ...modifiers]);
      }),
      Match.exhaustive,
    );

    return b.objectProperty(b.identifier(field.name), value as ExpressionKind);
  });

  return b.callExpression(
    b.memberExpression(b.identifier("S"), b.identifier("Struct")),
    [b.objectExpression(properties)],
  );
}

// =============================================================================
// Plugin Definition
// =============================================================================

/**
 * Effect Schemas plugin - generates schemas for enums, domains, and table shapes
 */
export function effectSchemas(config: ParsedEffectConfig): Plugin {
  return {
    name: "effect-schemas",

    provides: ["effect:schemas"],

    fileDefaults: [
      {
        pattern: "effect:schema:",
        fileNaming: ({ folderName }) => `${folderName}.ts`,
      },
    ],

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const cj = yield* Conjure;
      const registry = yield* SymbolRegistry;

      const { enums, domains, tables } = classifyEntities(ir.entities.values());

      // Generate schema constants for all enums
      const enumSchemaStmts = yield* Effect.forEach(enums, entity =>
        cj.exp.const(entity.name, buildEnumSchemaExpr(entity), {
          capability: `effect:schema:${entity.name}`,
          imports: effectSchemaImports,
          baseEntityName: entity.name,
        }),
      );

      // Generate schema constants for all domains
      const domainSchemaStmts = yield* Effect.forEach(domains, domain =>
        cj.exp.const(domain.name, buildDomainSchemaExpr(domain), {
          capability: `effect:schema:${domain.name}`,
          imports: effectSchemaImports,
          baseEntityName: domain.name,
        }),
      );

      // Generate S.Struct schemas for all table shapes.
      // Skip row shapes when models are enabled — Model.Class covers them.
      const tableSchemaStmts = yield* Effect.forEach(tables, entity =>
        Effect.forEach(
          getEntityShapes(entity).filter(s => !(config.modelsEnabled && s.kind === "row")),
          shape =>
          Effect.gen(function* () {
            const capability = `effect:schema:${shape.name}`;
            const schemaInit = registry.forSymbol(capability, () =>
              shapeToEffectStruct(shape, enums, domains, registry, entity.checkConstraints),
            );

            const schemaStmt = yield* cj.exp.const(shape.name, schemaInit, {
              capability,
              imports: effectSchemaImports,
              baseEntityName: entity.name,
            });

            const stmts = [schemaStmt];

            if (config.exportTypes) {
              const typeStmt = yield* cj.exp.type(`${shape.name}Type`, buildInferredType(shape.name), {
                capability: `${capability}:type`,
                imports: effectSchemaImports,
                baseEntityName: entity.name,
              });
              stmts.push(typeStmt);
            }

            return stmts;
          }),
        ),
      );

      const schemaStmts = [...enumSchemaStmts, ...domainSchemaStmts, ...Arr.flatten(Arr.flatten(tableSchemaStmts))];

      // Optionally generate type aliases for enums and domains
      if (!config.exportTypes) {
        return schemaStmts;
      }

      const enumTypeStmts = yield* Effect.forEach(enums, entity =>
        cj.exp.type(`${entity.name}Type`, buildInferredType(entity.name), {
          capability: `effect:schema:${entity.name}:type`,
          imports: effectSchemaImports,
          baseEntityName: entity.name,
        }),
      );

      const domainTypeStmts = yield* Effect.forEach(domains, domain =>
        cj.exp.type(`${domain.name}Type`, buildInferredType(domain.name), {
          capability: `effect:schema:${domain.name}:type`,
          imports: effectSchemaImports,
          baseEntityName: domain.name,
        }),
      );

      return [...schemaStmts, ...enumTypeStmts, ...domainTypeStmts];
    }),
  };
}
