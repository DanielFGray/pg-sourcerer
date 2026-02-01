/**
 * Types Plugin - Generates TypeScript interfaces from IR entities
 *
 * This is the foundational plugin that demonstrates the two-phase architecture:
 * 1. declare: Announces type:EntityName capabilities for each table entity
 * 2. render: Produces TypeScript interface AST nodes
 *
 * Other plugins can consume these types via the SymbolRegistry.
 */
import { Effect, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { TSTypeKind } from "ast-types/lib/gen/kinds.js";
import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import {
  isEnumEntity,
  isTableEntity,
  isDomainEntity,
  type EnumEntity,
  type DomainEntity,
  type Field,
  type Shape,
  type TableEntity,
} from "../ir/semantic-ir.js";
import { conjure } from "../conjure/index.js";
import { types } from "../conjure/types.js";
import { resolveFieldTypeInfo } from "./shared/pg-types.js";

const b = conjure.b;

// =============================================================================
// Field to TypeScript Property
// =============================================================================

/**
 * Convert a Field to a TSPropertySignature for interface generation.
 */
function fieldToTsType(
  field: Field,
  enumMap: Map<string, string>,
  domainMap: Map<string, string>,
): TSTypeKind {
  const pgType = field.pgAttribute.getType();
  
  // Check if this field uses a domain type
  const isDomain = pgType?.typtype === "d";
  if (isDomain && pgType) {
    const domainTypeName = domainMap.get(pgType.typname);
    if (domainTypeName) {
      return pipe(
        types.ref(domainTypeName),
        t => (field.isArray ? types.array(t) : t),
        t => (field.nullable ? types.nullable(t) : t),
      );
    }
  }

  const resolved = resolveFieldTypeInfo(field);
  const typeName = resolved?.typeName ?? "unknown";
  const typeInfo = resolved?.typeInfo;

  const isEnum = typeInfo?.typtype === "e" || typeInfo?.typcategory === "E";

  return pipe(
    isEnum ? types.ref(enumMap.get(typeName) ?? typeName) : types.fromPg(typeName),
    t => (field.isArray ? types.array(t) : t),
    t => (field.nullable ? types.nullable(t) : t),
  );
}

function fieldToPropertySignature(
  field: Field,
  enumMap: Map<string, string>,
  domainMap: Map<string, string>,
  readonly: boolean,
): n.TSPropertySignature {
  const propName = b.identifier(field.name);
  const tsType = fieldToTsType(field, enumMap, domainMap);

  const sig = b.tsPropertySignature(propName, b.tsTypeAnnotation(tsType));
  sig.optional = field.optional;
  if (readonly) sig.readonly = true;

  return sig;
}

// =============================================================================
// Entity to Interface
// =============================================================================

/**
 * Generate an interface declaration for a table entity's row shape.
 *
 * @example
 * // For a "users" table with id, email, name columns:
 * interface User {
 *   readonly id: string;
 *   readonly email: string;
 *   readonly name: string | null;
 * }
 */
function shapeToInterface(
  shape: Shape,
  enumMap: Map<string, string>,
  domainMap: Map<string, string>,
  readonly: boolean,
): n.TSInterfaceDeclaration {
  const members = shape.fields.map(field => fieldToPropertySignature(field, enumMap, domainMap, readonly));
  return b.tsInterfaceDeclaration(b.identifier(shape.name), b.tsInterfaceBody(members));
}

function enumToTypeAlias(entity: EnumEntity): n.TSTypeAliasDeclaration {
  const union = b.tsUnionType(entity.values.map(value => b.tsLiteralType(b.stringLiteral(value))));
  return b.tsTypeAliasDeclaration(b.identifier(entity.name), union);
}

/**
 * Convert a domain entity to a type alias.
 * Domains are branded types in the database, but in TypeScript we just alias to the base type.
 */
function domainToTypeAlias(entity: DomainEntity): n.TSTypeAliasDeclaration {
  // Map domain base type to TypeScript type
  const tsType = types.fromPg(entity.baseTypeName);
  return b.tsTypeAliasDeclaration(b.identifier(entity.name), tsType);
}

// =============================================================================
// Types Plugin Definition
// =============================================================================

/**
 * The types plugin factory - generates TypeScript interfaces from database entities.
 *
 * Capabilities provided:
 * - `type:EntityName` for each table/view entity
 *
 * Example output:
 * ```typescript
 * export interface User {
 *   readonly id: string;
 *   readonly email: string;
 *   readonly createdAt: Date;
 * }
 * ```
 */
export function typesPlugin(): Plugin {
  return {
    name: "types",

    // We dynamically declare capabilities based on IR entities
    // This empty array is filled during declare phase
    provides: [],

    fileDefaults: [
      {
        pattern: "type:",
        fileNaming: () => "types.ts",
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;
      const entities = [...ir.entities.values()];

      const enumDeclarations = entities
        .filter(isEnumEntity)
        .map(entity => ({ name: entity.name, capability: `type:${entity.name}` }));

      const domainDeclarations = entities
        .filter(isDomainEntity)
        .map(entity => ({ name: entity.name, capability: `type:${entity.name}` }));

      const getEntityShapes = (entity: TableEntity): Shape[] =>
        [entity.shapes.row, entity.shapes.update, entity.shapes.insert].filter(Boolean) as Shape[];

      const tableDeclarations = entities
        .filter(isTableEntity)
        .flatMap(entity =>
          getEntityShapes(entity).map(shape => ({
            name: shape.name,
            capability: `type:${shape.name}`,
          })),
        );

      return [...enumDeclarations, ...domainDeclarations, ...tableDeclarations];
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const entities = [...ir.entities.values()];

      const enumEntities = entities.filter(isEnumEntity);
      const domainEntities = entities.filter(isDomainEntity);
      const tableEntities = entities.filter(isTableEntity);

      const enumMap = new Map(enumEntities.map(entity => [entity.pgType.typname, entity.name]));
      const domainMap = new Map(domainEntities.map(entity => [entity.pgType.typname, entity.name]));

      // Render enum types first (domains may reference them, tables reference both)
      const enumSymbols: RenderedSymbol[] = enumEntities.map(entity => ({
        name: entity.name,
        capability: `type:${entity.name}`,
        node: enumToTypeAlias(entity),
        exports: "named",
      }));

      // Render domain types (tables reference these)
      const domainSymbols: RenderedSymbol[] = domainEntities.map(entity => ({
        name: entity.name,
        capability: `type:${entity.name}`,
        node: domainToTypeAlias(entity),
        exports: "named",
      }));

      // Render table interfaces
      const getEntityShapes = (entity: TableEntity): Shape[] =>
        [entity.shapes.row, entity.shapes.update, entity.shapes.insert].filter(Boolean) as Shape[];

      const tableSymbols: RenderedSymbol[] = tableEntities.flatMap(entity =>
        getEntityShapes(entity).map(shape => ({
          name: shape.name,
          capability: `type:${shape.name}`,
          node: shapeToInterface(shape, enumMap, domainMap, shape.kind === "row"),
          exports: "named" as const,
        })),
      );

      return [...enumSymbols, ...domainSymbols, ...tableSymbols];
    }),
  };
}
