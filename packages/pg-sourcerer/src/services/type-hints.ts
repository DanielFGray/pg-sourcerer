/**
 * Type Hint Registry Service
 *
 * Provides user-configured type overrides that plugins can query.
 *
 * Precedence rules (higher score wins):
 * - schema + table + column: 9 points
 * - table + column: 7 points
 * - schema + column: 6 points
 * - schema + table: 5 points
 * - column: 4 points
 * - table: 3 points
 * - schema: 2 points
 * - pgType: 1 point
 *
 * For same specificity, later rules in config override earlier ones.
 */
import { Context, Layer, Option, Order, pipe, Array as Arr } from "effect";
import type { TypeHint, TypeHintMatch } from "../config.js";

/**
 * Field matching criteria for type hints
 */
export interface TypeHintFieldMatch {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly pgType: string;
}

/**
 * Type hint registry interface
 */
export interface TypeHintRegistry {
  /**
   * Get all hints for a specific field (merged from all matching rules)
   * More specific matches take precedence over general ones
   */
  readonly getHints: (field: TypeHintFieldMatch) => Record<string, unknown>;

  /**
   * Get a specific hint value for a field
   */
  readonly getHint: <T>(field: TypeHintFieldMatch, key: string) => Option.Option<T>;
}

/**
 * TypeHintRegistry service tag
 */
export class TypeHints extends Context.Tag("TypeHints")<TypeHints, TypeHintRegistry>() {}

/**
 * Scored hint for sorting by precedence
 */
interface ScoredHint {
  readonly hint: TypeHint;
  readonly score: number;
  readonly index: number;
}

/**
 * Calculate specificity score for a match pattern.
 *
 * Scoring:
 * - schema: 2 points
 * - table: 3 points
 * - column: 4 points
 * - pgType: 1 point
 *
 * Combinations add up:
 * - schema+table+column = 9 points
 * - table+column = 7 points
 * - etc.
 */
function calculateScore(match: TypeHintMatch): number {
  let score = 0;
  if (match.schema !== undefined) score += 2;
  if (match.table !== undefined) score += 3;
  if (match.column !== undefined) score += 4;
  if (match.pgType !== undefined) score += 1;
  return score;
}

/**
 * Check if a hint's match pattern matches a field
 */
function matchesField(match: TypeHintMatch, field: TypeHintFieldMatch): boolean {
  // All specified criteria must match
  if (match.schema !== undefined && match.schema !== field.schema) return false;
  if (match.table !== undefined && match.table !== field.table) return false;
  if (match.column !== undefined && match.column !== field.column) return false;
  if (match.pgType !== undefined && match.pgType !== field.pgType) return false;
  // At least one criterion must be specified
  return (
    match.schema !== undefined ||
    match.table !== undefined ||
    match.column !== undefined ||
    match.pgType !== undefined
  );
}

/**
 * Order for sorting scored hints by (score, index) ascending.
 * Lower scores come first, so higher scores override them.
 */
const scoredHintOrder: Order.Order<ScoredHint> = Order.combine(
  Order.mapInput(Order.number, (sh: ScoredHint) => sh.score),
  Order.mapInput(Order.number, (sh: ScoredHint) => sh.index),
);

/**
 * Create a type hint registry from configuration
 */
export function createTypeHintRegistry(hints: readonly TypeHint[]): TypeHintRegistry {
  // Pre-calculate scores for all hints with their original index
  const scoredHints: readonly ScoredHint[] = pipe(
    hints,
    Arr.map((hint, index) => ({
      hint,
      score: calculateScore(hint.match),
      index,
    })),
  );

  const getHintsImpl = (field: TypeHintFieldMatch): Record<string, unknown> => {
    // Find all matching hints
    const matching = pipe(
      scoredHints,
      Arr.filter(sh => matchesField(sh.hint.match, field)),
    );

    // Sort by score (ascending), then by index (ascending)
    // Lower score/index first, so later ones override
    const sorted = Arr.sort(matching, scoredHintOrder);

    // Merge hints - later (higher score/index) overrides earlier
    return Arr.reduce(sorted, {} as Record<string, unknown>, (merged, sh) => ({
      ...merged,
      ...sh.hint.hints,
    }));
  };

  return {
    getHints: getHintsImpl,

    getHint: <T>(field: TypeHintFieldMatch, key: string): Option.Option<T> => {
      const allHints = getHintsImpl(field);
      return Option.fromNullable(allHints[key] as T | undefined);
    },
  };
}

/**
 * Empty registry for testing
 */
export const emptyTypeHintRegistry: TypeHintRegistry = {
  getHints: () => ({}),
  getHint: () => Option.none(),
};

/**
 * Create a live layer from config
 */
export function TypeHintsLive(hints: readonly TypeHint[]) {
  return Layer.succeed(TypeHints, createTypeHintRegistry(hints));
}
