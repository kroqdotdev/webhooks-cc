import { describe, expect, it } from "vitest";
import { getAllDocSlugs, getDocBySlug } from "./docs";
import { buildDocMarkdown, mdxToMarkdown } from "./docs-markdown";

const APP = "https://webhooks.cc";
const PAGE = `${APP}/docs/example`;

function convert(source: string): string {
  return mdxToMarkdown(source, { appUrl: APP, pageUrl: PAGE });
}

/** The lines of a markdown document that are outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^[>\s]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
    } else {
      lines.push(line);
    }
  }
  return lines;
}

describe("mdxToMarkdown", () => {
  it("drops ESM statements, including ones spanning several lines", () => {
    const out = convert(
      'import { Foo } from "./foo";\nexport const meta = {\n  a: 1,\n};\n\n# Title\n\nBody.'
    );
    expect(out).toBe("# Title\n\nBody.");
  });

  it("numbers steps as headings and unwraps their content", () => {
    const out = convert(
      '<Steps>\n<Step title="Create">\n\nFirst.\n\n</Step>\n<Step title="Send">\n\nSecond.\n\n</Step>\n</Steps>'
    );
    expect(out).toBe("### 1. Create\n\nFirst.\n\n### 2. Send\n\nSecond.");
  });

  it("turns callouts into labelled blockquotes, code included", () => {
    const out = convert(
      '<Callout type="warning">\n  Mind the `t` value.\n\n```ts\nconst x = 1;\n```\n</Callout>\n\nAfter.'
    );
    expect(out).toBe(
      "> **Warning**\n>\n>   Mind the `t` value.\n>\n> ```ts\n> const x = 1;\n> ```\n\nAfter."
    );
  });

  it("turns multi-line link cards into absolute list links", () => {
    const out = convert(
      '<LinkCard\n  href="/docs/sdk"\n  title="Use the SDK"\n  description="Integrate it."\n/>'
    );
    expect(out).toBe(`- [Use the SDK](${APP}/docs/sdk): Integrate it.`);
  });

  it("gives API methods and FAQ items headings, and unwraps tables", () => {
    const out = convert(
      '<ApiMethod method="POST" path="/endpoints" title="client.endpoints.create">\n\nCreates one.\n\n<ParamTable>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n</ParamTable>\n</ApiMethod>\n\n<FAQ>\n<FAQItem question="Does it count?">\n\nNo.\n\n</FAQItem>\n</FAQ>'
    );
    expect(out).toBe(
      "### client.endpoints.create\n\n`POST /endpoints`\n\nCreates one.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n### Does it count?\n\nNo."
    );
  });

  it("makes site links and fragments absolute, but not inside code", () => {
    const out = convert(
      "See [the API](/docs/api), [below](#limits), [GitHub](https://github.com) and `[x](/y)`.\n\n```md\n[kept](/as-is)\n```\n\n[ref]: /docs/cli"
    );
    expect(out).toBe(
      `See [the API](${APP}/docs/api), [below](${PAGE}#limits), [GitHub](https://github.com) and \`[x](/y)\`.\n\n\`\`\`md\n[kept](/as-is)\n\`\`\`\n\n[ref]: ${APP}/docs/cli`
    );
  });

  it("leaves code blocks byte for byte, even with JSX-looking lines", () => {
    const code = "```tsx\nimport { X } from 'y';\n\n\n<Steps>\nexport default X;\n```";
    expect(convert(code)).toBe(code);
  });

  it("drops JSX comments", () => {
    expect(convert("Before.\n\n{/* hidden\n   note */}\n\nAfter.")).toBe("Before.\n\nAfter.");
  });

  it("replaces the interactive MCP install guide with the commands it shows", () => {
    const out = convert("<McpInstallGuide />\n\n## Next");
    expect(out).toContain("## Install");
    expect(out).toContain("claude mcp add -s user webhooks-cc");
    expect(out).toContain("npx skills add kroqdotdev/webhooks-cc");
    expect(out.endsWith("## Next")).toBe(true);
  });
});

describe("buildDocMarkdown", () => {
  it("adds frontmatter with the canonical page, the title and the description", async () => {
    const doc = await getDocBySlug("agents");
    const markdown = buildDocMarkdown(doc!, APP);

    expect(markdown).toMatch(/^---\ntitle: "[^"]+"\ndescription: "[^"]+"\n/);
    expect(markdown).toContain(`canonical: ${APP}/docs/agents\n`);
    expect(markdown).toContain(
      `\n# ${doc!.frontmatter.title}\n\n${doc!.frontmatter.description}\n`
    );
  });

  it("lists every docs page as markdown on the docs root", async () => {
    const markdown = buildDocMarkdown((await getDocBySlug(""))!, APP);
    expect(markdown).toContain("## All documentation pages");
    expect(markdown).toContain(`(${APP}/docs/agents.md)`);
    expect(markdown).toContain(`canonical: ${APP}/docs\n`);
  });

  it("converts every docs page without leaving MDX behind", async () => {
    const slugs = await getAllDocSlugs();
    expect(slugs.length).toBeGreaterThan(10);
    for (const slug of slugs) {
      const markdown = buildDocMarkdown((await getDocBySlug(slug))!, APP);
      for (const line of proseLines(markdown)) {
        expect(line, `${slug}: ${line}`).not.toMatch(/^[>\s]*<\/?[A-Z][A-Za-z]*[\s/>]/);
        expect(line, `${slug}: ${line}`).not.toMatch(/^(import|export)\s/);
        expect(line, `${slug}: ${line}`).not.toMatch(/\]\(\/(?!\/)/);
      }
    }
  });
});
