import type { DocPage } from "@/lib/docs";
import { NAV_SECTIONS } from "@/lib/docs-nav";

// -------------------------------------------------------------------
// Markdown twins of the docs pages, for agents (proxy.ts serves them for
// Accept: text/markdown and at /docs/<slug>.md). Derived from the same MDX
// source the HTML page renders: prose, headings, tables and code blocks pass
// through; ESM lines are dropped; the docs components become the plain
// markdown they stand for; relative links become absolute.
// -------------------------------------------------------------------

/** The canonical HTML URL of a docs page. */
export function docPageUrl(appUrl: string, slug: string): string {
  return slug ? `${appUrl}/docs/${slug}` : `${appUrl}/docs`;
}

/** The markdown twin of a docs page. */
export function docMarkdownUrl(appUrl: string, slug: string): string {
  return slug ? `${appUrl}/docs/${slug}.md` : `${appUrl}/docs.md`;
}

const CALLOUT_LABELS: Record<string, string> = {
  info: "Note",
  tip: "Tip",
  warning: "Warning",
  danger: "Danger",
};

// The install commands <McpInstallGuide /> (components/docs/mdx/mcp-setup.tsx
// and agent-skill-install.tsx) renders, minus its key field and buttons. The
// MDX puts it under its "Local server" heading, so it brings no heading.
const MCP_INSTALL_GUIDE = `Replace \`whcc_...\` with an API key from https://webhooks.cc/account/api-keys.

Claude Code plugin (the local MCP server plus the webhook testing skill):

\`\`\`text
/plugin install webhooks-cc --marketplace kroqdotdev/webhooks-cc
\`\`\`

The agent skill for Cursor, Codex, Copilot and other agents that read SKILL.md:

\`\`\`bash
npx skills add kroqdotdev/webhooks-cc
\`\`\`

Claude Code:

\`\`\`bash
claude mcp add -s user webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp
\`\`\`

Cursor, VS Code, Windsurf and Claude Desktop:

\`\`\`bash
npx @webhooks-cc/mcp setup cursor --api-key whcc_...
npx @webhooks-cc/mcp setup vscode --api-key whcc_...
npx @webhooks-cc/mcp setup windsurf --api-key whcc_...
npx @webhooks-cc/mcp setup claude-desktop --api-key whcc_...
\`\`\`

OpenAI Codex:

\`\`\`bash
codex mcp add webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp
\`\`\`

Any tool that reads an MCP config file:

\`\`\`json
{
  "mcpServers": {
    "webhooks-cc": {
      "command": "npx",
      "args": ["-y", "@webhooks-cc/mcp"],
      "env": { "WHK_API_KEY": "whcc_..." }
    }
  }
}
\`\`\``;

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
}

const TAG_START = /^\s*<\/?[A-Z][A-Za-z0-9.]*/;
const FENCE = /^\s*(`{3,}|~{3,})/;

function parseTag(raw: string): Tag | null {
  const match = /^\s*<(\/?)([A-Z][A-Za-z0-9.]*)([\s\S]*?)(\/?)>\s*$/.exec(raw);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\})/g;
  let attr;
  while ((attr = attrRe.exec(match[3])) !== null) {
    attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? "";
  }
  return {
    name: match[2],
    closing: match[1] === "/",
    selfClosing: match[4] === "/",
    attrs,
  };
}

/** Whether a JSX tag spanning several lines has reached its closing `>`. */
function tagComplete(raw: string): boolean {
  let quote: string | null = null;
  let braces = 0;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      braces++;
    } else if (ch === "}") {
      braces--;
    } else if (ch === ">" && braces === 0) {
      return true;
    }
  }
  return false;
}

/** Makes a site-relative or fragment link absolute. */
function absoluteHref(href: string, appUrl: string, pageUrl: string): string {
  if (href.startsWith("#")) return `${pageUrl}${href}`;
  if (href.startsWith("/") && !href.startsWith("//")) return `${appUrl}${href}`;
  return href;
}

/** Rewrites the links of one prose line, leaving inline code spans alone. */
function absolutizeLinks(line: string, appUrl: string, pageUrl: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(
          /\]\((\/(?!\/)[^)\s]*|#[^)\s]*)((?:\s+"[^"]*")?)\)/g,
          (_m, href: string, title: string) => `](${absoluteHref(href, appUrl, pageUrl)}${title})`
        )
        .replace(
          /^(\s*\[[^\]]+\]:\s*)(\/(?!\/)\S*|#\S*)/,
          (_m, label: string, href: string) => `${label}${absoluteHref(href, appUrl, pageUrl)}`
        );
    })
    .join("");
}

/**
 * Converts the MDX body of a docs page to plain markdown. Pure: `appUrl`
 * makes site links absolute, `pageUrl` resolves `#fragment` links.
 */
export function mdxToMarkdown(source: string, options: { appUrl: string; pageUrl: string }) {
  const { appUrl, pageUrl } = options;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const steps: number[] = [];
  let calloutDepth = 0;
  let fence: { char: string; length: number } | null = null;

  // Lines inside a <Callout> become a blockquote. Outside code blocks, a
  // run of blank lines (left where tags were dropped) becomes one.
  const emit = (line: string) => {
    const blank = line.trim() === "";
    let value = line;
    if (calloutDepth > 0) {
      value = blank ? ">".repeat(calloutDepth) : `${"> ".repeat(calloutDepth)}${line}`;
    }
    if (blank && !fence && (out.length === 0 || out[out.length - 1] === value)) return;
    out.push(value);
  };
  const emitBlock = (block: string) => {
    for (const line of block.split("\n")) emit(line);
  };
  // A block the converter writes starts a paragraph of its own.
  const startBlock = () => {
    const last = out[out.length - 1];
    if (last !== undefined && last.replace(/>/g, "").trim() !== "") emit("");
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      emit(line);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }

    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      emit(line);
      continue;
    }

    // MDX ESM: import and export statements at the start of a line.
    if (/^(import|export)\s/.test(line)) {
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/[{[(]/g) ?? []).length;
        depth -= (lines[j].match(/[}\])]/g) ?? []).length;
        i = j;
        if (depth <= 0) break;
      }
      continue;
    }

    // JSX comments, on one line or several.
    if (/^\s*\{\/\*/.test(line)) {
      while (i < lines.length && !lines[i].includes("*/}")) i++;
      continue;
    }

    if (TAG_START.test(line)) {
      let raw = line;
      while (!tagComplete(raw) && i + 1 < lines.length) {
        raw += `\n${lines[++i]}`;
      }
      const tag = parseTag(raw);
      if (tag) {
        emitTag(tag);
        continue;
      }
      // Not a lone tag (inline JSX inside prose): keep the text as written.
      for (const part of raw.split("\n")) emit(absolutizeLinks(part, appUrl, pageUrl));
      continue;
    }

    emit(absolutizeLinks(line, appUrl, pageUrl));
  }

  function emitTag(tag: Tag) {
    const { attrs } = tag;
    switch (tag.name) {
      case "Steps":
        if (tag.closing) steps.pop();
        else if (!tag.selfClosing) steps.push(0);
        return;
      case "Step": {
        if (tag.closing) return;
        const n = steps.length > 0 ? ++steps[steps.length - 1] : 1;
        startBlock();
        emit(`### ${n}. ${attrs.title ?? ""}`.trimEnd());
        return;
      }
      case "ApiMethod":
        if (tag.closing) return;
        startBlock();
        emitBlock(
          `### ${attrs.title ?? attrs.path ?? ""}\n\n\`${attrs.method ?? ""} ${attrs.path ?? ""}\``
        );
        return;
      case "FAQItem":
        if (tag.closing || !attrs.question) return;
        startBlock();
        emit(`### ${attrs.question}`);
        return;
      case "Callout":
        if (tag.selfClosing) return;
        if (tag.closing) {
          calloutDepth = Math.max(0, calloutDepth - 1);
          // Ends the quote, so the next line cannot continue it lazily.
          emit("");
          return;
        }
        startBlock();
        calloutDepth++;
        emit(`**${CALLOUT_LABELS[attrs.type ?? "info"] ?? "Note"}**`);
        emit("");
        return;
      case "LinkCard":
      case "ProviderCard": {
        if (tag.closing || !attrs.href) return;
        const href = absoluteHref(attrs.href, appUrl, pageUrl);
        const title = attrs.title ?? attrs.name ?? href;
        emit(`- [${title}](${href})${attrs.description ? `: ${attrs.description}` : ""}`);
        return;
      }
      case "McpInstallGuide":
        startBlock();
        emitBlock(MCP_INSTALL_GUIDE);
        return;
      default:
        // Layout wrappers (ParamTable, FAQ, Tabs) and anything unknown: the
        // children carry the content.
        return;
    }
  }

  return out.join("\n").trim();
}

function yamlString(value: string): string {
  // A JSON string is a valid double-quoted YAML scalar.
  return JSON.stringify(value);
}

function isoDate(value: string | Date | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** The docs sidebar as a list, linking the markdown twins of docs pages. */
function docsIndexSection(appUrl: string): string {
  const lines = ["## All documentation pages", ""];
  for (const section of NAV_SECTIONS) {
    lines.push(`### ${section.title}`, "");
    for (const item of section.items) {
      const slug = item.href === "/docs" ? "" : item.href.replace(/^\/docs\//, "");
      const href = item.href.startsWith("/docs")
        ? docMarkdownUrl(appUrl, slug)
        : `${appUrl}${item.href}`;
      lines.push(`${item.depth ? "  " : ""}- [${item.title}](${href})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The whole markdown twin of a docs page: frontmatter naming the canonical
 * HTML page, the title and description the page shows, and the body. The
 * docs root also lists every page, as its sidebar does.
 */
export function buildDocMarkdown(doc: DocPage, appUrl: string): string {
  const { frontmatter: fm } = doc;
  const pageUrl = docPageUrl(appUrl, doc.slug);
  const updated = isoDate(fm.lastUpdated);
  // The page's own canonical, which a doc covering a marketing page's ground
  // hands to that page.
  const canonical = fm.canonical ? absoluteHref(fm.canonical, appUrl, pageUrl) : pageUrl;
  const header = [
    "---",
    `title: ${yamlString(fm.title)}`,
    `description: ${yamlString(fm.description)}`,
    `canonical: ${canonical}`,
    ...(updated ? [`last_updated: ${updated}`] : []),
    "---",
    "",
    `# ${fm.title}`,
    "",
    fm.description,
  ].join("\n");
  const parts = [header, mdxToMarkdown(doc.content, { appUrl, pageUrl })];
  if (doc.slug === "") parts.push(docsIndexSection(appUrl));
  return `${parts.join("\n\n")}\n`;
}
