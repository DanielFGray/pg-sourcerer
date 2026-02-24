/**
 * Domain Constraint Parser
 *
 * Parses PostgreSQL domain CHECK constraint definitions to extract validation patterns.
 * This is similar to check-constraint-parser.ts but uses `VALUE` as the placeholder
 * instead of column names, since domain constraints operate on the value itself.
 *
 * Handles expressions like:
 * - CHECK ((length((value)::text) >= 2))
 * - CHECK ((length((value)::text) <= 24))
 * - CHECK ((value ~ '^pattern$'::text))
 * - CHECK ((value ~* '^pattern$'))
 * - CHECK (((length((value)::text) >= 2) AND (length((value)::text) <= 24) AND (value ~ '...')))
 */

import type { DomainValidation } from "../ir/semantic-ir.js";

/**
 * Parse a domain CHECK constraint definition to extract validation logic.
 * Returns an array to support compound constraints with multiple validations.
 *
 * Domain constraints use `VALUE` (case-insensitive) as a placeholder for the value
 * being validated, unlike table CHECK constraints which reference column names.
 *
 * @param expression - Raw constraint expression (from DomainConstraint.expression)
 * @returns Array of validation rules. Empty array if unparseable.
 *
 * @example
 * parseDomainExpression("CHECK ((length((value)::text) >= 2))")
 * // => [{ kind: "minLength", value: 2 }]
 *
 * parseDomainExpression("CHECK ((value ~ '^[a-zA-Z]+$'::text))")
 * // => [{ kind: "regex", pattern: "^[a-zA-Z]+$" }]
 *
 * parseDomainExpression("CHECK (((length((value)::text) >= 2) AND (length((value)::text) <= 24)))")
 * // => [{ kind: "minLength", value: 2 }, { kind: "maxLength", value: 24 }]
 */
export function parseDomainExpression(expression: string): DomainValidation[] {
  // Defensive: handle empty or undefined expressions
  if (!expression) {
    return [{ kind: "unknown", raw: "" }];
  }

  // Strip "CHECK (" prefix and trailing ")"
  const stripped = expression.replace(/^CHECK\s*\((.+)\)$/i, "$1").trim();

  const results: DomainValidation[] = [];

  // String length range: (length(value) >= X AND length(value) <= Y)
  // Handle type casts like length((value)::text)
  // Match both variations: (length(...) and (length((...):...)
  // For combined constraints, we return separate minLength and maxLength validations
  const lengthRangePattern1 = new RegExp(
    `length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*>=?\\s*(\\d+).*AND.*length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*<=\\s*(\\d+)`,
    "i",
  );
  const lengthRangePattern2 = new RegExp(
    `length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*<=\\s*(\\d+).*AND.*length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*>=?\\s*(\\d+)`,
    "i",
  );

  const lengthRangeMatch1 = stripped.match(lengthRangePattern1);
  if (lengthRangeMatch1) {
    let min = Number(lengthRangeMatch1[1]!);
    const max = Number(lengthRangeMatch1[2]!);
    // Check if it's > instead of >= (must not be followed by =)
    const isGt = stripped.match(/length\([^)]+\)\s*>(?!=)\s*\d/i);
    if (isGt) min += 1;
    results.push({ kind: "minLength", value: min }, { kind: "maxLength", value: max });
  }

  const lengthRangeMatch2 = stripped.match(lengthRangePattern2);
  if (lengthRangeMatch2 && !lengthRangeMatch1) {
    const max = Number(lengthRangeMatch2[1]!);
    let min = Number(lengthRangeMatch2[2]!);
    // Check if it's > instead of >= (must not be followed by =)
    const isGt = stripped.match(/length\([^)]+\)\s*>(?!=)\s*\d/i);
    if (isGt) min += 1;
    results.push({ kind: "minLength", value: min }, { kind: "maxLength", value: max });
  }

  // Only check standalone min/max length if lengthRange didn't match
  if (!lengthRangeMatch1 && !lengthRangeMatch2) {
    // Min length: (length(value) > X) or (length(value) >= X)
    const minLengthPattern = new RegExp(
      `\\(length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*>=?\\s*(\\d+)`,
      "i",
    );
    const minLengthMatch = stripped.match(minLengthPattern);
    if (minLengthMatch && !stripped.includes("AND")) {
      const val = Number(minLengthMatch[1]!);
      // If it's ">" we need val+1 for ">="
      const isGt = stripped.match(/length\([^)]+\)\s*>\s*/i);
      results.push({ kind: "minLength", value: isGt ? val + 1 : val });
    }

    // Max length: (length(value) <= X)
    const maxLengthPattern = new RegExp(
      `\\(length\\(\\(?(?:value|VALUE)\\)?(?:::[^)]+)?\\)\\s*<=\\s*(\\d+)`,
      "i",
    );
    const maxLengthMatch = stripped.match(maxLengthPattern);
    if (maxLengthMatch && !stripped.includes("AND")) {
      results.push({ kind: "maxLength", value: Number(maxLengthMatch[1]!) });
    }
  }

  // Regex: (value ~ 'pattern') or (value ~* 'pattern')
  // ~* is case-insensitive in PostgreSQL
  // Handle type casts: 'pattern'::text
  const regexPattern = new RegExp(
    `(?:value|VALUE)\\s*~(\\*)?\\s*'([^']+)'(?:::[a-z]+)?`,
    "i",
  );
  const regexMatch = stripped.match(regexPattern);
  if (regexMatch) {
    const caseInsensitive = regexMatch[1] === "*";
    results.push({
      kind: "regex",
      pattern: regexMatch[2]!,
      ...(caseInsensitive && { caseInsensitive: true }),
    });
  }

  // Fallback: unparseable
  if (results.length === 0) {
    return [{ kind: "unknown", raw: expression }];
  }

  return results;
}
