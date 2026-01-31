import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { parseDomainExpression } from "./domain-constraint-parser.js";

describe("parseDomainExpression", () => {
  it.effect("parses minLength constraint", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((length((value)::text) >= 2))");
      expect(result).toEqual([{ kind: "minLength", value: 2 }]);
    }),
  );

  it.effect("parses maxLength constraint", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((length(value) <= 24))");
      expect(result).toEqual([{ kind: "maxLength", value: 24 }]);
    }),
  );

  it.effect("parses lengthRange constraint (returns minLength and maxLength)", () =>
    Effect.sync(() => {
      const result = parseDomainExpression(
        "CHECK (((length((value)::text) >= 2) AND (length((value)::text) <= 24)))",
      );
      expect(result).toEqual([{ kind: "minLength", value: 2 }, { kind: "maxLength", value: 24 }]);
    }),
  );

  it.effect("parses regex constraint", () =>
    Effect.sync(() => {
      const result = parseDomainExpression(
        "CHECK ((value ~ '^[a-zA-Z][a-zA-Z0-9_-]+$'::citext))",
      );
      expect(result).toEqual([{ kind: "regex", pattern: "^[a-zA-Z][a-zA-Z0-9_-]+$" }]);
    }),
  );

  it.effect("parses case-insensitive regex constraint", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((value ~* '^[a-z]+$'::text))");
      expect(result).toEqual([{ kind: "regex", pattern: "^[a-z]+$", caseInsensitive: true }]);
    }),
  );

  it.effect("parses username domain constraint (minLength + maxLength + regex)", () =>
    Effect.sync(() => {
      const result = parseDomainExpression(
        "CHECK (((length((value)::text) >= 2) AND (length((value)::text) <= 24) AND (value ~ '^[a-zA-Z][a-zA-Z0-9_-]+$'::citext)))",
      );
      expect(result).toEqual([
        { kind: "minLength", value: 2 },
        { kind: "maxLength", value: 24 },
        { kind: "regex", pattern: "^[a-zA-Z][a-zA-Z0-9_-]+$" },
      ]);
    }),
  );

  it.effect("parses url domain constraint (simple regex)", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((value ~ '^https?://\\S+'))");
      expect(result).toEqual([{ kind: "regex", pattern: "^https?://\\S+" }]);
    }),
  );

  it.effect("handles VALUE in uppercase", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((length((VALUE)::text) >= 2))");
      expect(result).toEqual([{ kind: "minLength", value: 2 }]);
    }),
  );

  it.effect("handles value in lowercase", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((length((value)::text) >= 2))");
      expect(result).toEqual([{ kind: "minLength", value: 2 }]);
    }),
  );

  it.effect("returns unknown for unparseable constraints", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((is_valid IS TRUE))");
      expect(result).toEqual([{ kind: "unknown", raw: "CHECK ((is_valid IS TRUE))" }]);
    }),
  );

  it.effect("returns unknown for empty expression", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("");
      expect(result).toEqual([{ kind: "unknown", raw: "" }]);
    }),
  );

  it.effect("handles > instead of >= for minLength", () =>
    Effect.sync(() => {
      const result = parseDomainExpression("CHECK ((length(value) > 0))");
      expect(result).toEqual([{ kind: "minLength", value: 1 }]);
    }),
  );

  it.effect("handles reversed lengthRange (max before min)", () =>
    Effect.sync(() => {
      const result = parseDomainExpression(
        "CHECK (((length(value) <= 50) AND (length(value) >= 3)))",
      );
      expect(result).toEqual([{ kind: "minLength", value: 3 }, { kind: "maxLength", value: 50 }]);
    }),
  );
});
