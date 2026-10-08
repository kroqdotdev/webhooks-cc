import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  countRemoteImages,
  disarmTags,
  previewPolicy,
} from "./email-preview";

describe("previewPolicy", () => {
  it("allows inline styles and embedded images only, until remote images are asked for", () => {
    expect(previewPolicy(false)).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:"
    );
    expect(previewPolicy(true)).toContain("img-src data: cid: https: http:");
    expect(previewPolicy(true)).not.toContain("script");
  });
});

describe("buildPreviewDocument", () => {
  it("puts the policy and a blank base target ahead of the email", () => {
    const doc = buildPreviewDocument("<p>Hi</p>", { allowRemoteImages: false });
    const policyAt = doc.indexOf("Content-Security-Policy");
    const baseAt = doc.indexOf('<base target="_blank">');
    const emailAt = doc.indexOf("<p>Hi</p>");
    expect(policyAt).toBeGreaterThan(0);
    expect(baseAt).toBeGreaterThan(policyAt);
    expect(emailAt).toBeGreaterThan(baseAt);
  });

  it("disarms the email's own meta, base and link tags", () => {
    const doc = buildPreviewDocument(
      [
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        "<META HTTP-EQUIV=Refresh content=1>",
        '<meta http-equiv="ref&#x72;esh" content="0;url=https://evil.example/encoded">',
        "<meta/http-equiv=refresh content=0>",
        '<me<meta>ta http-equiv="refresh" content="0">',
        '<base href="https://evil.example/">',
        '<link rel="preconnect" href="https://evil.example">',
        '<LINK rel="dns-prefetch" href="//evil.example">',
        "<p>x</p>",
      ].join(""),
      { allowRemoteImages: true }
    );
    // Only the document's own charset and policy metas and its base remain.
    expect(doc.match(/<meta\b/gi)).toHaveLength(2);
    expect(doc.match(/<base\b/gi)).toHaveLength(1);
    expect(doc.match(/<link\b/gi)).toBeNull();
    expect(doc).toContain('<x-meta http-equiv="refresh"');
    expect(doc).toContain("<p>x</p>");
  });
});

describe("disarmTags", () => {
  it("leaves other tags and text alone", () => {
    expect(disarmTags('<metadata><p class="meta">base and link</p><linked>')).toBe(
      '<metadata><p class="meta">base and link</p><linked>'
    );
  });
});

describe("countRemoteImages", () => {
  it("counts img sources, srcset, background attributes and CSS urls", () => {
    const html = [
      '<img src="https://tidewater.app/logo.png">',
      "<img src='//cdn.example.com/a.png'>",
      '<img srcset="https://cdn.example.com/b.png 2x">',
      '<td background="http://example.com/bg.jpg">',
      '<div style="background:url(https://example.com/c.png)">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="cid:logo">',
    ].join("");
    expect(countRemoteImages(html)).toBe(5);
    expect(countRemoteImages("<p>No images</p>")).toBe(0);
  });
});
