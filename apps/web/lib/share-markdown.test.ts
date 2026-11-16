import { describe, expect, it } from "vitest";
import { getAllShareFrameworkPages, getShareFrameworkPage } from "./share-framework-pages";
import { buildShareMarkdown } from "./share-markdown";

const APP = "https://webhooks.cc";

describe("buildShareMarkdown", () => {
  it("names the canonical page and carries the guide's content", () => {
    const page = getShareFrameworkPage("vite")!;
    const markdown = buildShareMarkdown(page, APP);
    expect(markdown).toContain(`canonical: ${APP}/share/vite`);
    expect(markdown).toContain(`# ${page.h1}`);
    expect(markdown).toContain("whk share 5173");
    for (const section of page.sections) expect(markdown).toContain(`## ${section.heading}`);
    for (const item of page.faq) expect(markdown).toContain(`### ${item.question}`);
    for (const source of page.sources) expect(markdown).toContain(source.href);
  });

  it("closes every code fence, whatever the snippet holds", () => {
    for (const page of getAllShareFrameworkPages()) {
      const markdown = buildShareMarkdown(page, APP);
      const fences = markdown.split("\n").filter((line) => /^`{3,}/.test(line));
      expect(fences.length % 2, page.slug).toBe(0);
    }
  });
});
