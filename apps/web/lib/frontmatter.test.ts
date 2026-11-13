import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("reads the block and leaves the body", () => {
    const { data, content } = parseFrontmatter(
      "---\ntitle: Hello\norder: 3\nlastUpdated: 2026-11-12\nkeywords: [a, b]\nseo:\n  ogTitle: X\n---\n# Body\n"
    );
    expect(data).toEqual({
      title: "Hello",
      order: 3,
      lastUpdated: new Date("2026-11-12T00:00:00Z"),
      keywords: ["a", "b"],
      seo: { ogTitle: "X" },
    });
    expect(content).toBe("# Body\n");
  });

  it("handles CRLF, a byte order mark and an empty block", () => {
    expect(parseFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nbody").data).toEqual({ name: "x" });
    expect(parseFrontmatter("---\n\n---\nbody")).toEqual({ data: {}, content: "body" });
    expect(parseFrontmatter("---\n---\nbody")).toEqual({ data: {}, content: "body" });
  });

  it("returns the whole text when there is no front matter", () => {
    expect(parseFrontmatter("# Just a page\n")).toEqual({ data: {}, content: "# Just a page\n" });
  });
});
