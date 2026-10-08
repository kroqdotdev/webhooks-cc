import { describe, expect, it } from "vitest";
import { buildPreviewDocument, countRemoteImages, previewPolicy } from "./email-preview";

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

  it("removes meta refresh and the email's own base tag", () => {
    const doc = buildPreviewDocument(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><META HTTP-EQUIV=Refresh content="1"><base href="https://evil.example/"><p>x</p>',
      { allowRemoteImages: true }
    );
    expect(doc).not.toMatch(/refresh/i);
    expect(doc).not.toContain("evil.example");
    expect(doc.match(/<base\b/g)).toHaveLength(1);
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
