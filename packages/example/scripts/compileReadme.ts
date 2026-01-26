/// <reference types="bun" />
/// <reference types="node" />

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const specPath = resolve(repoRoot, "docs/spec/README.mdx");
const outputPath = resolve(repoRoot, "README.md");

const stripDecoration = (line: string) => {
  if (line.startsWith("## !!section ")) {
    return `## ${line.slice("## !!section ".length)}`;
  }

  if (line.startsWith("### !!claim ")) {
    const rest = line.slice("### !!claim ".length);
    const parts = rest.trimStart().split(/\s+/, 2);
    const remainder = rest.slice(parts[0]?.length ?? 0).trimStart();
    return remainder.length === 0 ? "###" : `### ${remainder}`;
  }

  return line;
};

const stripFenceMeta = (line: string) =>
  line
    .replace(/\s+!expected\b/, "")
    .replace(/\s+!actual\b/, "")
    .replace(/\s+!\w+\b/, "")
    .replace(/\s+$/, "");

const isMetadataLine = (line: string) =>
  line.startsWith("!source ") ||
  line.startsWith("!plugin ") ||
  line.startsWith("!file ") ||
  line.startsWith("!notes ");

const loadActual = async (filePath: string | null) => {
  if (!filePath) return "";
  const absolute = resolve(repoRoot, filePath);
  const file = Bun.file(absolute);
  if (!(await file.exists())) {
    return "";
  }
  return file.text();
};

const findSnippet = (fileContent: string, expected: string | null) => {
  if (!expected || expected.trim().length === 0) return null;
  const index = fileContent.indexOf(expected);
  if (index < 0) return null;
  return expected.trimEnd();
};

const compileReadme = async () => {
  const specFile = Bun.file(specPath);
  if (!(await specFile.exists())) {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const spec = await specFile.text();
  const lines = spec.split("\n");
  const output: string[] = [];

  let currentFile: string | null = null;
  let inActual = false;
  let inExpected = false;
  let expectedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("### !!claim ")) {
      currentFile = null;
      output.push(stripDecoration(line));
      continue;
    }

    if (line.startsWith("## !!section ")) {
      output.push(stripDecoration(line));
      continue;
    }

    if (line.startsWith("!file ")) {
      currentFile = line.slice("!file ".length).trim();
      continue;
    }

    if (isMetadataLine(line)) {
      continue;
    }

    const fenceMatch = line.match(/^```(.*)$/);
    if (fenceMatch) {
      const fenceMeta = fenceMatch[1] ?? "";
      const isActual = fenceMeta.includes("!actual");
      const isExpected = fenceMeta.includes("!expected");

      if (inExpected && !isExpected && !isActual) {
        inExpected = false;
        output.push(line);
        continue;
      }

      if (isActual) {
        inActual = true;
        output.push(stripFenceMeta(line));
        const actual = await loadActual(currentFile);
        const expected = expectedLines.length > 0 ? expectedLines.join("\n").trimEnd() : null;
        const snippet = findSnippet(actual, expected);
        if (snippet) {
          output.push(snippet);
        } else if (actual.length > 0) {
          output.push(actual.trimEnd());
        }
        continue;
      }

      if (isExpected) {
        inExpected = true;
        expectedLines = [];
      }

      if (inActual) {
        inActual = false;
        output.push(line);
        continue;
      }

      output.push(stripFenceMeta(line));
      continue;
    }

    if (inExpected) {
      if (line.startsWith("```")) {
        inExpected = false;
        output.push(line);
        continue;
      }
      expectedLines.push(line);
      output.push(line);
      continue;
    }

    if (inActual) {
      continue;
    }

    output.push(stripDecoration(line));
  }

  const compiled = output.join("\n").replace(/\n{3,}/g, "\n\n");
  await Bun.write(outputPath, compiled.trimEnd() + "\n");
};

compileReadme().catch(error => {
  console.error(error);
  process.exit(1);
});
