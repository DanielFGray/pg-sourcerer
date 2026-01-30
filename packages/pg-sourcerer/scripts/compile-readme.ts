#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Compile MDX spec to regular Markdown README for npm releases.
 * Uses CodeHike's parser to properly extract content without annotations.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluate } from "@mdx-js/mdx";
import { parse } from "codehike";
import { recmaCodeHike, remarkCodeHike } from "codehike/mdx";

const repoRoot = resolve(import.meta.dir, "../../..");
const specPath = resolve(repoRoot, "docs/spec/README.mdx");
const outputPath = resolve(repoRoot, "packages/pg-sourcerer/README.md");

const Fragment = Symbol.for("mdx.fragment");
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: string) => ({
  type,
  props: props ?? {},
  key: key ?? null,
});
const jsxs = jsx;

interface CodeBlock {
  lang: string;
  meta: string;
  value: string;
}

interface JSXNode {
  type: string | symbol;
  props: Record<string, unknown>;
  key: unknown;
}

interface Claim {
  title?: string;
  id?: string;
  expected?: CodeBlock;
  children?: JSXNode;
  [key: string]: unknown;
}

interface Section {
  title?: string;
  claim?: Claim[];
  claims?: Claim[];
  children?: JSXNode;
  [key: string]: unknown;
}

/**
 * Convert JSX tree to markdown text.
 * Handles common elements: p, ol, ul, li, code, pre, strong, em, a
 */
function jsxToMarkdown(node: unknown, indent = ""): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  
  // Handle arrays
  if (Array.isArray(node)) {
    return node.map(child => jsxToMarkdown(child, indent)).join("");
  }
  
  // Handle JSX nodes
  if (typeof node === "object" && "type" in node && "props" in node) {
    const jsxNode = node as JSXNode;
    const children = jsxNode.props.children;
    const childText = jsxToMarkdown(children, indent);
    
    // Handle specific HTML/markdown elements
    switch (jsxNode.type) {
      case "p":
        return `${childText}\n\n`;
      case "ol": {
        const start = jsxNode.props.start ? Number(jsxNode.props.start) : 1;
        // Process list items with numbering
        const items = Array.isArray(children) ? children : [children];
        let num = start;
        return items.map(item => {
          if (typeof item === "object" && "type" in item && item.type === "li") {
            const text = jsxToMarkdown((item as JSXNode).props.children, "   ");
            return `${num++}. ${text.trim()}\n`;
          }
          return jsxToMarkdown(item, indent);
        }).join("") + "\n";
      }
      case "ul": {
        const items = Array.isArray(children) ? children : [children];
        return items.map(item => {
          if (typeof item === "object" && "type" in item && item.type === "li") {
            const text = jsxToMarkdown((item as JSXNode).props.children, "   ");
            return `- ${text.trim()}\n`;
          }
          return jsxToMarkdown(item, indent);
        }).join("") + "\n";
      }
      case "li":
        return childText;
      case "code":
        return `\`${childText}\``;
      case "pre":
        return `\`\`\`\n${childText}\n\`\`\`\n\n`;
      case "strong":
      case "b":
        return `**${childText}**`;
      case "em":
      case "i":
        return `*${childText}*`;
      case "a": {
        const href = jsxNode.props.href;
        return `[${childText}](${href})`;
      }
      case "h1":
        return `# ${childText}\n\n`;
      case "h2":
        return `## ${childText}\n\n`;
      case "h3":
        return `### ${childText}\n\n`;
      case "h4":
        return `#### ${childText}\n\n`;
      case "table":
      case "thead":
      case "tbody":
      case "tr":
      case "td":
      case "th":
        // Tables are complex - just preserve the structure
        return childText;
      default:
        // For unknown elements, just render children
        return childText;
    }
  }
  
  return String(node);
}

function extractMarkdown(sections: Section[]): string {
  const lines: string[] = [];
  
  for (const section of sections) {
    // Add section heading
    if (section.title) {
      lines.push(`## ${section.title}`);
      lines.push("");
    }
    
    // Add section prose (children before claims)
    if (section.children) {
      const prose = jsxToMarkdown(section.children);
      if (prose.trim()) {
        lines.push(prose.trim());
        lines.push("");
      }
    }
    
    // Get claims from either 'claim' or 'claims' property
    const claims = section.claims ?? section.claim ?? [];
    
    for (const claim of claims) {
      // Claims structure: the expected code comes BEFORE the claim's children prose
      // This matches the source order where prose after a claim heading belongs to the next section
      
      // Add expected code block first
      if (claim.expected) {
        const { lang, value } = claim.expected;
        lines.push(`\`\`\`${lang}`);
        lines.push(value.trim());
        lines.push("```");
        lines.push("");
      }
      
      // Then add claim's children (continuation prose)
      if (claim.children) {
        const prose = jsxToMarkdown(claim.children);
        if (prose.trim()) {
          lines.push(prose.trim());
          lines.push("");
        }
      }
    }
  }
  
  return lines.join("\n").trim() + "\n";
}

async function compileReadme() {
  const mdxSource = await readFile(specPath, "utf8");
  
  // Compile MDX with CodeHike
  const module = await evaluate(mdxSource, {
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
  
  // Parse with CodeHike to extract structured data
  const content = module.default as (props: Record<string, unknown>) => unknown;
  const raw = parse(content) as Record<string, unknown>;
  const sectionsValue = raw["sections"] ?? raw["section"];
  
  if (!sectionsValue || !Array.isArray(sectionsValue)) {
    throw new Error("Could not extract sections from MDX spec.");
  }
  
  // Extract clean markdown
  const markdown = extractMarkdown(sectionsValue as Section[]);
  
  await writeFile(outputPath, markdown, "utf8");
  console.log(`✅ Compiled ${specPath} → ${outputPath}`);
  console.log(`   Extracted ${(sectionsValue as Section[]).length} sections`);
}

compileReadme().catch(error => {
  console.error("❌ Failed to compile README:", error);
  process.exit(1);
});
