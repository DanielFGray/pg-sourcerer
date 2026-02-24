import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { parseCheckConstraint } from "./check-constraint-parser.js";

describe("parseCheckConstraint", () => {
  it.effect("parses min constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint("CHECK ((price >= (0)::numeric))", "price");
      expect(result).toEqual([{ kind: "min", value: 0 }]);
    }),
  );

  it.effect("parses max constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint("CHECK ((age <= 150))", "age");
      expect(result).toEqual([{ kind: "max", value: 150 }]);
    }),
  );

  it.effect("parses range constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((discount_percent >= 0) AND (discount_percent <= 100)))",
        "discount_percent",
      );
      expect(result).toEqual([{ kind: "range", min: 0, max: 100 }]);
    }),
  );

  it.effect("parses range constraint (reversed)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((rating >= 0.0) AND (rating <= 5.0)))",
        "rating",
      );
      expect(result).toEqual([{ kind: "range", min: 0, max: 5 }]);
    }),
  );

  it.effect("parses exclusive range (> and <)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((age > 0) AND (age < 150)))",
        "age",
      );
      expect(result).toEqual([{ kind: "range", min: 0, max: 150, exclusive: { min: true, max: true } }]);
    }),
  );

  it.effect("parses mixed exclusive/inclusive range (> and <=)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((score > 0) AND (score <= 100)))",
        "score",
      );
      expect(result).toEqual([{ kind: "range", min: 0, max: 100, exclusive: { min: true, max: false } }]);
    }),
  );

  it.effect("parses mixed inclusive/exclusive range (>= and <)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((temperature >= -273.15) AND (temperature < 1000)))",
        "temperature",
      );
      expect(result).toEqual([{ kind: "range", min: -273.15, max: 1000, exclusive: { min: false, max: true } }]);
    }),
  );

  it.effect("parses quoted negative numbers in range", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((temperature >= '-273.15'::numeric) AND (temperature < (1000)::numeric)))",
        "temperature",
      );
      expect(result).toEqual([{ kind: "range", min: -273.15, max: 1000, exclusive: { min: false, max: true } }]);
    }),
  );

  it.effect("parses length range constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((length(name) > 0) AND (length(name) <= 100)))",
        "name",
      );
      expect(result).toEqual([{ kind: "lengthRange", min: 1, max: 100 }]);
    }),
  );

  it.effect("parses max length constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint("CHECK ((length(bio) <= 4000))", "bio");
      expect(result).toEqual([{ kind: "maxLength", value: 4000 }]);
    }),
  );

  it.effect("parses enum constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))",
        "status",
      );
      expect(result).toEqual([{ kind: "enum", values: ["draft", "active", "archived"] }]);
    }),
  );

  it.effect("parses regex constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((email ~ '[^@]+@[^@]+\\.[^@]+'::citext))",
        "email",
      );
      expect(result).toEqual([{ kind: "regex", pattern: "[^@]+@[^@]+\\.[^@]+" }]);
    }),
  );

  it.effect("parses case-insensitive regex constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((username ~* '^[a-z][a-z0-9_]+$'::text))",
        "username",
      );
      expect(result).toEqual([{ kind: "regex", pattern: "^[a-z][a-z0-9_]+$", flags: "i" }]);
    }),
  );

  it.effect("parses LIKE pattern (converts to regex)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((email LIKE '%@%.%'::text))",
        "email",
      );
      expect(result).toEqual([{ kind: "regex", pattern: ".*@.*\\..*" }]);
    }),
  );

  it.effect("parses ILIKE pattern (converts to case-insensitive regex)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((domain ILIKE '%.com'::text))",
        "domain",
      );
      expect(result).toEqual([{ kind: "regex", pattern: ".*\\.com", flags: "i" }]);
    }),
  );

  it.effect("parses ~~ operator (PostgreSQL LIKE)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((email ~~ '%@%.%'::text))",
        "email",
      );
      expect(result).toEqual([{ kind: "regex", pattern: ".*@.*\\..*" }]);
    }),
  );

  it.effect("parses ~~* operator (PostgreSQL ILIKE)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((domain ~~* '%.org'::text))",
        "domain",
      );
      expect(result).toEqual([{ kind: "regex", pattern: ".*\\.org", flags: "i" }]);
    }),
  );

  it.effect("parses NOT LIKE pattern (not supported, returns unknown)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK ((username NOT LIKE '%admin%'::text))",
        "username",
      );
      expect(result).toEqual([{ kind: "unknown", sql: "CHECK ((username NOT LIKE '%admin%'::text))" }]);
    }),
  );

  it.effect("parses compound constraint (length range + regex)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((length((VALUE)::text) >= 2) AND (length((VALUE)::text) <= 24) AND (VALUE ~ '^[a-zA-Z][a-zA-Z0-9_-]+$'::citext)))",
        "VALUE",
      );
      expect(result).toEqual([
        { kind: "lengthRange", min: 2, max: 24 },
        { kind: "regex", pattern: "^[a-zA-Z][a-zA-Z0-9_-]+$" }
      ]);
    }),
  );

  it.effect("parses compound constraint (length range + case-insensitive regex)", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((length((VALUE)::text) >= 3) AND (length((VALUE)::text) <= 50) AND (VALUE ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$'::text)))",
        "VALUE",
      );
      expect(result).toEqual([
        { kind: "lengthRange", min: 3, max: 50 },
        { kind: "regex", pattern: "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$", flags: "i" }
      ]);
    }),
  );

  it.effect("returns unknown for complex constraint", () =>
    Effect.sync(() => {
      const result = parseCheckConstraint(
        "CHECK (((is_primary IS FALSE) OR (is_verified IS TRUE)))",
        "is_primary",
      );
      expect(result).toEqual([{ kind: "unknown", sql: "CHECK (((is_primary IS FALSE) OR (is_verified IS TRUE)))" }]);
    }),
  );
});
