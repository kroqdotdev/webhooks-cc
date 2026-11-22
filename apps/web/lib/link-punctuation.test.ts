import { describe, expect, it } from "vitest";
import { withoutTrailingPunctuation } from "./link-punctuation";

describe("withoutTrailingPunctuation", () => {
  it("drops what a sentence or parentheses left on a link", () => {
    expect(withoutTrailingPunctuation("/account/api-keys.")).toBe("/account/api-keys");
    expect(withoutTrailingPunctuation("/docs/layouts)")).toBe("/docs/layouts");
    expect(withoutTrailingPunctuation("/docs/layouts);")).toBe("/docs/layouts");
    expect(withoutTrailingPunctuation("/docs/sdk/testing/pytest),")).toBe(
      "/docs/sdk/testing/pytest"
    );
    expect(withoutTrailingPunctuation("/docs/share!")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share:")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share'")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share]")).toBe("/docs/share");
  });

  it("drops the encoded quotes, brackets and backticks a browser sends", () => {
    expect(withoutTrailingPunctuation("/docs/share%22")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share%3E")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share%60.")).toBe("/docs/share");
    expect(withoutTrailingPunctuation("/docs/share%29")).toBe("/docs/share");
  });

  it("keeps a trailing slash and leaves the root for a path of punctuation only", () => {
    expect(withoutTrailingPunctuation("/docs/.")).toBe("/docs/");
    expect(withoutTrailingPunctuation("/...")).toBe("/");
  });

  it("leaves ordinary paths alone", () => {
    for (const path of ["/", "/docs/share", "/install.sh", "/docs.md", "/s/AbC-_9", "/docs/"]) {
      expect(withoutTrailingPunctuation(path)).toBeNull();
    }
  });
});
