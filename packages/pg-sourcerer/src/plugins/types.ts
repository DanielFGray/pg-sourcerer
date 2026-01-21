/**
 * Types Plugin - Generates TypeScript interfaces from IR entities
 *
 * This is the foundational plugin that demonstrates the two-phase architecture:
 * 1. declare: Announces type:EntityName capabilities for each table entity
 * 2. render: Produces TypeScript interface AST nodes
 *
 * Other plugins can consume these types via the SymbolRegistry.
 */
import { Effect, Array as Arr, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { isTableEntity, type TableEntity, type Field } from "../ir/semantic-ir.js";
import { conjure } from "../conjure/index.js";
import { types } from "../conjure/types.js";

const b = conjure.b;

// =============================================================================
// Field to TypeScript Property
// =============================================================================

/**
 * Convert a Field to a TSPropertySignature for interface generation.
 */
function fieldToPropertySignature(field: Field): n.TSPropertySignature {
  const propName = b.identifier(field.name);
  const tsType = types.fromField(field);

  const sig = b.tsPropertySignature(propName, b.tsTypeAnnotation(tsType));
  sig.readonly = true;

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
function entityToInterface(entity: TableEntity): n.TSInterfaceDeclaration {
  const members = entity.shapes.row.fields.map(fieldToPropertySignature);

  // entity.name is already the inflected name (done by IR builder)
  return b.tsInterfaceDeclaration(b.identifier(entity.name), b.tsInterfaceBody(members));
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

      // entity.name is already inflected by the IR builder
      return pipe(
        Array.from(ir.entities.values()),
        Arr.filter(isTableEntity),
        Arr.map(
          (entity): SymbolDeclaration => ({
            name: entity.name,
            capability: `type:${entity.name}`,
          }),
        ),
      );
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;

      // entity.name is already inflected by the IR builder
      return pipe(
        Array.from(ir.entities.values()),
        Arr.filter(isTableEntity),
        Arr.map(
          (entity): RenderedSymbol => ({
            name: entity.name,
            capability: `type:${entity.name}`,
            node: entityToInterface(entity),
            exports: "named",
          }),
        ),
      );
    }),
  };
}
