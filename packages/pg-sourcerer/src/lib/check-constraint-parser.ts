/**
 * Check Constraint Parser
 *
 * Parses SQL CHECK constraint definitions to extract validation patterns.
 * This is intentionally simple - we only handle common patterns that map cleanly
 * to schema validation libraries. Complex constraints are ignored.
 */

/**
 * Validation extracted from a CHECK constraint
 */
export type ConstraintValidation =
  | { kind: "min"; value: number }
  | { kind: "max"; value: number }
  | { kind: "range"; min: number; max: number; exclusive?: { min: boolean; max: boolean } }
  | { kind: "minLength"; value: number }
  | { kind: "maxLength"; value: number }
  | { kind: "lengthRange"; min: number; max: number }
  | { kind: "enum"; values: string[] }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "unknown"; sql: string }; // Fallback for unparseable constraints

/**
 * Parse a CHECK constraint definition to extract validation logic.
 * Returns an array to support compound constraints with multiple validations.
 *
 * @param definition - SQL from pg_get_constraintdef()
 * @param columnName - Name of the column this constraint applies to
 * @returns Array of validation rules. Empty array if unparseable.
 *
 * @example
 * parseCheckConstraint("CHECK ((price >= (0)::numeric))", "price")
 * // => [{ kind: "min", value: 0 }]
 *
 * parseCheckConstraint("CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text])))", "status")
 * // => [{ kind: "enum", values: ["draft", "active"] }]
 *
 * parseCheckConstraint("CHECK ((length(name) >= 2 AND length(name) <= 24 AND name ~ '^[A-Z]'))", "name")
 * // => [{ kind: "lengthRange", min: 2, max: 24 }, { kind: "regex", pattern: "^[A-Z]" }]
 */
export function parseCheckConstraint(
  definition: string,
  columnName: string,
): ConstraintValidation[] {
  // Defensive: handle empty or undefined definitions
  if (!definition || !columnName) {
    return [{ kind: "unknown", sql: definition || "" }];
  }

  // Strip "CHECK (" prefix and trailing ")"
  const stripped = definition.replace(/^CHECK\s*\((.+)\)$/i, "$1").trim();
  
  const results: ConstraintValidation[] = [];

  // Numeric range: (col >= X AND col <= Y) or (col <= Y AND col >= X)
  // Also handles exclusive ranges: (col > X AND col < Y)
  // Values may be quoted: '-273.15'::numeric
  const rangePattern1 = new RegExp(
    `${columnName}\\s*(>=?|<=?)\\s*\\(?'?([\\d.-]+)'?.*AND.*${columnName}\\s*(>=?|<=?)\\s*\\(?'?([\\d.-]+)'?`,
    "i",
  );
  
  const rangeMatch1 = stripped.match(rangePattern1);
  if (rangeMatch1) {
    const [, op1, val1, op2, val2] = rangeMatch1;
    
    // Determine which is min and which is max based on operator
    let min: number, max: number;
    let minExclusive = false, maxExclusive = false;
    
    if (op1 === ">=" || op1 === ">") {
      // col >= X AND col <= Y
      min = Number(val1!);
      max = Number(val2!);
      minExclusive = op1 === ">";
      maxExclusive = op2 === "<";
    } else {
      // col <= Y AND col >= X
      min = Number(val2!);
      max = Number(val1!);
      minExclusive = op2 === ">";
      maxExclusive = op1 === "<";
    }
    
    const exclusive = (minExclusive || maxExclusive) 
      ? { min: minExclusive, max: maxExclusive }
      : undefined;
    
    results.push({ kind: "range", min, max, ...(exclusive && { exclusive }) });
  }

  // String length range: (length(col) >= X AND length(col) <= Y)
  // Handle optional type casts like length((col)::text)
  const lengthRangePattern1 = new RegExp(
    `length\\(\\(?${columnName}\\)?(?:::[^)]+)?\\)\\s*>=?\\s*(\\d+).*AND.*length\\(\\(?${columnName}\\)?(?:::[^)]+)?\\)\\s*<=\\s*(\\d+)`,
    "i",
  );
  const lengthRangePattern2 = new RegExp(
    `length\\(\\(?${columnName}\\)?(?:::[^)]+)?\\)\\s*<=\\s*(\\d+).*AND.*length\\(\\(?${columnName}\\)?(?:::[^)]+)?\\)\\s*>=?\\s*(\\d+)`,
    "i",
  );
  
  const lengthRangeMatch1 = stripped.match(lengthRangePattern1);
  if (lengthRangeMatch1) {
    let min = Number(lengthRangeMatch1[1]!);
    // Check if it's > instead of >=
    const isGt = stripped.match(/length\([^)]+\)\s*>\s*/i);
    if (isGt) min += 1;
    const max = Number(lengthRangeMatch1[2]!);
    results.push({ kind: "lengthRange", min, max });
  }
  
  const lengthRangeMatch2 = stripped.match(lengthRangePattern2);
  if (lengthRangeMatch2 && !lengthRangeMatch1) {
    let min = Number(lengthRangeMatch2[2]!);
    // Check if it's > instead of >=
    const isGt = stripped.match(/length\([^)]+\)\s*>\s*/i);
    if (isGt) min += 1;
    const max = Number(lengthRangeMatch2[1]!);
    results.push({ kind: "lengthRange", min, max });
  }

  // Only check standalone min/max if range didn't match
  if (!rangeMatch1) {
    // Min value: (col >= X) - may be quoted
    const minPattern = new RegExp(`\\(${columnName}\\s*>=\\s*\\(?'?([\\d.-]+)'?`, "i");
    const minMatch = stripped.match(minPattern);
    if (minMatch && !stripped.includes("AND")) {
      results.push({ kind: "min", value: Number(minMatch[1]!) });
    }

    // Max value: (col <= X) - may be quoted
    const maxPattern = new RegExp(`\\(${columnName}\\s*<=\\s*\\(?'?([\\d.-]+)'?`, "i");
    const maxMatch = stripped.match(maxPattern);
    if (maxMatch && !stripped.includes("AND")) {
      results.push({ kind: "max", value: Number(maxMatch[1]!) });
    }
  }

  // Only check standalone min/max length if lengthRange didn't match
  if (!lengthRangeMatch1 && !lengthRangeMatch2) {
    // Min length: (length(col) > X) or (length(col) >= X)
    const minLengthPattern = new RegExp(
      `\\(length\\(${columnName}\\)\\s*>=?\\s*(\\d+)`,
      "i",
    );
    const minLengthMatch = stripped.match(minLengthPattern);
    if (minLengthMatch && !stripped.includes("AND")) {
      const val = Number(minLengthMatch[1]!);
      // If it's ">" we need val+1 for ">="
      const isGt = stripped.match(new RegExp(`length\\(${columnName}\\)\\s*>\\s*`, "i"));
      results.push({ kind: "minLength", value: isGt ? val + 1 : val });
    }

    // Max length: (length(col) <= X)
    const maxLengthPattern = new RegExp(
      `\\(length\\(${columnName}\\)\\s*<=\\s*(\\d+)`,
      "i",
    );
    const maxLengthMatch = stripped.match(maxLengthPattern);
    if (maxLengthMatch && !stripped.includes("AND")) {
      results.push({ kind: "maxLength", value: Number(maxLengthMatch[1]!) });
    }
  }

  // Enum: (col = ANY (ARRAY['val1', 'val2', ...]))
  const enumPattern = new RegExp(
    `\\(${columnName}\\s*=\\s*ANY\\s*\\(ARRAY\\[([^\\]]+)\\]\\)\\)`,
    "i",
  );
  const enumMatch = stripped.match(enumPattern);
  if (enumMatch) {
    const valuesStr = enumMatch[1]!;
    // Extract quoted strings
    const values = [...valuesStr.matchAll(/'([^']+)'/g)].map(m => m[1]!);
    if (values.length > 0) {
      results.push({ kind: "enum", values });
    }
  }

  // LIKE/ILIKE pattern: (col LIKE 'pattern') or (col ~~ 'pattern')
  // PostgreSQL normalizes LIKE to ~~ and ILIKE to ~~*
  // Convert to regex. ILIKE/~~* is case-insensitive.
  // % matches any sequence, _ matches single character
  // NOT LIKE is not supported (negation is complex)
  const likePattern = new RegExp(`\\(${columnName}\\s+(?:(I?LIKE)|~~(\\*)?)\\s+'([^']+)'`, "i");
  const likeMatch = stripped.match(likePattern);
  if (likeMatch) {
    const keyword = likeMatch[1]; // "LIKE" or "ILIKE" or undefined
    const tildeStar = likeMatch[2]; // "*" or undefined
    const pattern = likeMatch[3]!;
    
    const isILike = (keyword && keyword.toUpperCase() === "ILIKE") || tildeStar === "*";
    
    // Convert SQL LIKE pattern to regex
    // Escape regex special chars except % and _
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex chars
      .replace(/%/g, '.*')                     // % -> .*
      .replace(/_/g, '.');                     // _ -> .
    
    results.push({
      kind: "regex",
      pattern: regexPattern,
      ...(isILike && { flags: "i" })
    });
  }

  // Regex: (col ~ 'pattern') or (col ~* 'pattern')
  // ~* is case-insensitive in PostgreSQL
  const regexPattern = new RegExp(`\\(${columnName}\\s*~(\\*)?\\s*'([^']+)'`, "i");
  const regexMatch = stripped.match(regexPattern);
  if (regexMatch) {
    const caseInsensitive = regexMatch[1] === "*";
    results.push({ 
      kind: "regex", 
      pattern: regexMatch[2]!,
      ...(caseInsensitive && { flags: "i" })
    });
  }

  // Fallback: unparseable
  if (results.length === 0) {
    return [{ kind: "unknown", sql: definition }];
  }
  
  return results;
}
