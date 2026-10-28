import { describe, expect, it } from "vitest";
import {
  hasMarkdownTwin,
  isMarkdownTwinPath,
  negotiatesMarkdown,
  prefersMarkdown,
} from "./markdown-negotiation";

const BROWSER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/markdown, text/html, */*", true],
    ["text/html;q=0.5, text/markdown;q=0.9", true],
    ["TEXT/MARKDOWN; charset=utf-8", true],
    ["text/markdown;q=0.8, */*;q=0.1", true],
  ])("serves markdown for %s", (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });

  it.each([
    [null],
    [""],
    ["*/*"],
    ["text/*"],
    [BROWSER],
    ["text/html, text/markdown;q=0.5"],
    ["text/markdown;q=0"],
    ["text/markdown;q=0.5, text/*"],
    ["text/markdown;q=0.4, */*;q=0.9"],
    ["text/markdownish"],
  ])("serves HTML for %s", (accept) => {
    expect(prefersMarkdown(accept)).toBe(false);
  });
});

describe("negotiatesMarkdown", () => {
  it.each(["/", "/docs", "/docs/agents", "/docs/mcp/tools"])(
    "answers %s with its twin for an agent",
    (pathname) => {
      expect(hasMarkdownTwin(pathname)).toBe(true);
      expect(negotiatesMarkdown(pathname, "text/markdown, text/html;q=0.9")).toBe(true);
      expect(negotiatesMarkdown(pathname, BROWSER)).toBe(false);
      expect(negotiatesMarkdown(pathname, null)).toBe(false);
    }
  );

  it.each([
    "/pricing",
    "/webhooks/stripe",
    "/documentation",
    "/api/endpoints",
    "/auth.md",
    "/index.md",
    "/docs.md/agents",
    "/docs/agents.md",
  ])("leaves %s alone", (pathname) => {
    expect(negotiatesMarkdown(pathname, "text/markdown")).toBe(false);
  });
});

describe("isMarkdownTwinPath", () => {
  it.each(["/index.md", "/docs.md", "/docs.md/agents", "/docs/agents.md", "/docs/sdk/api.md"])(
    "marks %s as a twin",
    (pathname) => expect(isMarkdownTwinPath(pathname)).toBe(true)
  );

  it.each(["/", "/docs", "/docs/agents", "/auth.md", "/llms.txt", "/docs.mdx"])(
    "does not mark %s",
    (pathname) => expect(isMarkdownTwinPath(pathname)).toBe(false)
  );
});
