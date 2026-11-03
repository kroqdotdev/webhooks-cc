import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "./markdown";

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

describe("support markdown", () => {
  it("splits paragraphs, lists and code", () => {
    const blocks = parseBlocks("Hello\nthere\n\n- one\n- two\n\n```\nconst x = 1;\n```\n1. first");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "code", "list"]);
  });

  it("never emits HTML from the text", () => {
    const out = html("<img src=x onerror=alert(1)> <script>alert(1)</script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only http(s) URLs, with nofollow", () => {
    const out = html(
      "[docs](https://webhooks.cc/docs) and [bad](javascript:alert(1)) https://example.com/a."
    );
    expect(out).toContain('href="https://webhooks.cc/docs"');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("renders inline code and bold", () => {
    const out = html("Use `whk listen` **now**");
    expect(out).toContain("<code");
    expect(out).toContain("whk listen");
    expect(out).toContain("<strong>now</strong>");
  });
});
