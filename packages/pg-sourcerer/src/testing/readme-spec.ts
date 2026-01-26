import { evaluate } from "@mdx-js/mdx";
import { parse } from "codehike";
import { recmaCodeHike, remarkCodeHike } from "codehike/mdx";
import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import { createPatch } from "diff";

type CodeBlock = {
  lang: string;
  meta: string;
  value: string;
};

type Claim = {
  title?: string;
  children?: unknown;
  id?: string;
  plugin?: string;
  file?: string;
  source?: string;
  notes?: string;
  expected?: CodeBlock;
  actual?: CodeBlock;
  _data?: unknown;
};

type Section = {
  title?: string;
  children?: unknown;
  claim?: ReadonlyArray<Claim>;
  claims?: ReadonlyArray<Claim>;
  _data?: unknown;
};

const CodeBlockSchema = Schema.Struct({
  lang: Schema.String,
  meta: Schema.String,
  value: Schema.String,
});

const ClaimSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.String),
  plugin: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  expected: Schema.optional(CodeBlockSchema),
  actual: Schema.optional(CodeBlockSchema),
  _data: Schema.optional(Schema.Unknown),
});

const SectionSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Unknown),
  claim: Schema.optional(Schema.Array(ClaimSchema)),
  claims: Schema.optional(Schema.Array(ClaimSchema)),
  _data: Schema.optional(Schema.Unknown),
});

const decodeSections = Schema.decodeUnknownSync(Schema.Array(SectionSchema));

const Fragment = Symbol.for("mdx.fragment");
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: string) => ({
  type,
  props: props ?? {},
  key: key ?? null,
});
const jsxs = jsx;

const normalizeText = (value: string) =>
  value.replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trim();

const toLines = (value: string) => normalizeText(value).split("\n");

const parseTypeScript = (value: string) =>
  recast.parse(value, {
    parser: {
      parse: (source: string) =>
        babelParse(source, {
          sourceType: "module",
          plugins: ["typescript", "jsx"],
          tokens: false,
        }),
    },
  });

const normalizeTypeScript = (value: string) => {
  try {
    return recast.print(parseTypeScript(value)).code.trim();
  } catch {
    return normalizeText(value);
  }
};

const normalizeSql = (value: string) =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/g, "")
    .trim();

const isTypeScriptLike = (lang?: string, filePath?: string) => {
  if (lang) {
    return ["ts", "tsx", "typescript", "js", "jsx", "javascript"].includes(lang);
  }
  return filePath ? /\.(ts|tsx|js|jsx)$/.test(filePath) : false;
};

const isSqlLike = (lang?: string, filePath?: string) => {
  if (lang) {
    return ["sql", "postgresql"].includes(lang);
  }
  return filePath ? /\.sql$/.test(filePath) : false;
};

const normalizeForComparison = (value: string, lang?: string, filePath?: string) => {
  if (isTypeScriptLike(lang, filePath)) {
    return normalizeTypeScript(value);
  }

  if (isSqlLike(lang, filePath)) {
    return normalizeSql(value);
  }

  return normalizeText(value);
};

const bestWindowMatch = (actualLines: readonly string[], expectedLines: readonly string[]) => {
  if (expectedLines.length === 0) {
    return { snippet: "", start: 0, score: 0 };
  }

  if (actualLines.length <= expectedLines.length) {
    return { snippet: actualLines.join("\n"), start: 0, score: 0 };
  }

  let bestScore = -1;
  let bestStart = 0;

  for (let start = 0; start <= actualLines.length - expectedLines.length; start += 1) {
    let score = 0;
    for (let index = 0; index < expectedLines.length; index += 1) {
      if (actualLines[start + index] === expectedLines[index]) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  const snippet = actualLines.slice(bestStart, bestStart + expectedLines.length).join("\n");
  return { snippet, start: bestStart, score: bestScore };
};

const buildDiff = (label: string, expected: string, actual: string) =>
  createPatch(label, expected, actual, "expected", "actual");

const resolveRepoRoot = () => resolve(import.meta.dir, "../../../..");

const resolveSpecPath = () => resolve(resolveRepoRoot(), "docs/spec/README.mdx");

const readSpec = async (specPath: string) => readFile(specPath, "utf8");

const compileSpec = async (specSource: string) => {
  const module = await evaluate(specSource, {
    development: false,
    remarkPlugins: [remarkCodeHike],
    recmaPlugins: [recmaCodeHike],
    Fragment,
    jsx,
    jsxs,
  });

  if (!module.default) {
    throw new Error("Spec MDX did not export a default component.");
  }

  return module.default as (props: Record<string, unknown>) => unknown;
};

const parseSpec = (content: (props: Record<string, unknown>) => unknown) => {
  const raw = parse(content);
  const root = raw as Record<string, unknown>;
  const sectionsValue = root["sections"] ?? root["section"];

  if (!sectionsValue) {
    throw new Error("Spec is missing sections. Use '## !!section <id>' headings.");
  }

  return decodeSections(sectionsValue);
};

const claimId = (claim: Claim, fallback: string) => claim.id ?? claim.title ?? fallback;

const getClaims = (section: Section): ReadonlyArray<Claim> =>
  section.claims ?? section.claim ?? [];

const verifyClaim = async (claim: Claim, repoRoot: string) => {
  if (!claim.expected) {
    return { status: "skipped" as const, message: "no expected snippet" };
  }

  if (!claim.file) {
    return { status: "skipped" as const, message: "missing file path" };
  }

  const filePath = isAbsolute(claim.file) ? claim.file : resolve(repoRoot, claim.file);
  const fileText = await readFile(filePath, "utf8").catch(() => null);
  if (fileText === null) {
    return { status: "failed" as const, message: `file not found: ${filePath}` };
  }

  const normalizedFileText = normalizeForComparison(fileText, claim.expected.lang, claim.file);
  const rawExpected = claim.expected.value;
  const normalizedExpected = normalizeForComparison(rawExpected, claim.expected.lang, claim.file);

  if (!normalizedFileText.includes(normalizedExpected)) {
    const rawExpectedLines = toLines(rawExpected);
    const rawActualLines = toLines(fileText);
    const rawMatch = bestWindowMatch(rawActualLines, rawExpectedLines);
    const normalizedExpectedLines = toLines(normalizedExpected);
    const normalizedActualLines = toLines(normalizedFileText);
    const normalizedMatch = bestWindowMatch(normalizedActualLines, normalizedExpectedLines);

    const rawDiff = buildDiff("raw", rawExpected, rawMatch.snippet);
    const normalizedDiff = buildDiff("normalized", normalizedExpected, normalizedMatch.snippet);

    const details = [
      `expected snippet not found in ${claim.file}`,
      "--- Raw diff",
      rawDiff.trimEnd(),
      "--- Normalized diff",
      normalizedDiff.trimEnd(),
    ].join("\n");

    return { status: "failed" as const, message: details };
  }

  return { status: "ok" as const, message: `matched ${claim.file}` };
};

export const verifyReadmeSpec = async (options?: { specPath?: string; repoRoot?: string }) => {
  const specPath = options?.specPath ?? resolveSpecPath();
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const specSource = await readSpec(specPath);
  const content = await compileSpec(specSource);
  const sections = parseSpec(content);

  let verified = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const [sectionIndex, section] of sections.entries()) {
    const claims = getClaims(section);
    for (const [claimIndex, claim] of claims.entries()) {
      const id = claimId(claim, `section-${sectionIndex}-claim-${claimIndex}`);
      const result = await verifyClaim(claim, repoRoot);
      if (result.status === "ok") {
        verified += 1;
        continue;
      }

      if (result.status === "skipped") {
        skipped += 1;
        continue;
      }

      failures.push(`[${id}] ${result.message}`);
    }
  }

  if (failures.length > 0) {
    const error = new Error("README spec verification failed");
    (error as Error & { details?: string[] }).details = failures;
    throw error;
  }

  return { verified, skipped };
};
