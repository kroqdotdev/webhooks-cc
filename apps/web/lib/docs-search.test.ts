import { describe, expect, test } from "vitest";

import { isDocsSearchUrl, normalizePagefindUrl } from "./docs-search";

describe("normalizePagefindUrl", () => {
  test("strips html suffixes from docs pages", () => {
    expect(normalizePagefindUrl("/docs/sdk/api.html")).toBe("/docs/sdk/api");
  });

  test("preserves query strings and hashes", () => {
    expect(normalizePagefindUrl("/docs/sdk/api.html?foo=bar#waitfor")).toBe(
      "/docs/sdk/api?foo=bar#waitfor"
    );
  });

  test("collapses index.html routes", () => {
    expect(normalizePagefindUrl("/docs/index.html")).toBe("/docs");
    expect(normalizePagefindUrl("/index.html")).toBe("/");
  });
});

describe("isDocsSearchUrl", () => {
  test("accepts docs routes", () => {
    expect(isDocsSearchUrl("/docs/sdk/api.html")).toBe(true);
    expect(isDocsSearchUrl("/docs")).toBe(true);
  });

  test("rejects non-docs routes", () => {
    expect(isDocsSearchUrl("/blog/test-post.html")).toBe(false);
    expect(isDocsSearchUrl("/compare/ngrok.html")).toBe(false);
  });
});
