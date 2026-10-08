import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  countImageReferences,
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
    const bodyAt = doc.indexOf("</head><body>");
    expect(policyAt).toBeGreaterThan(0);
    expect(baseAt).toBeGreaterThan(policyAt);
    expect(bodyAt).toBeGreaterThan(baseAt);
  });

  it("shows nothing of the email without a DOM parser to sanitize it", () => {
    // Node has no DOMParser; the browser path is covered by tests/e2e/email-capture.spec.ts.
    const doc = buildPreviewDocument('<a href="https://evil.example" target="_self">x</a>', {
      allowRemoteImages: false,
    });
    expect(doc).not.toContain("evil.example");
    expect(doc).toContain("</head><body></body></html>");
  });
});

describe("disarmTags", () => {
  it("renames meta, base, link, svg and math start tags however they are written", () => {
    const html = disarmTags(
      [
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        "<META HTTP-EQUIV=Refresh content=1>",
        '<meta http-equiv="ref&#x72;esh" content="0;url=https://evil.example/encoded">',
        "<meta/http-equiv=refresh content=0>",
        '<me<meta>ta http-equiv="refresh" content="0">',
        '<base href="https://evil.example/">',
        '<link rel="preconnect" href="https://evil.example">',
        '<LINK rel="dns-prefetch" href="//evil.example">',
        '<svg><a href="https://evil.example"><text>x</text></a></svg>',
        "<math><mi>x</mi></math>",
        "<p>x</p>",
      ].join("")
    );
    expect(html.match(/<(meta|base|link|svg|math)\b/gi)).toBeNull();
    expect(html).toContain('<x-meta http-equiv="refresh"');
    expect(html).toContain("<x-svg><a href=");
    expect(html).toContain("<p>x</p>");
  });

  it("leaves other tags and text alone", () => {
    expect(disarmTags('<metadata><p class="meta">base, link and svg</p><linked>')).toBe(
      '<metadata><p class="meta">base, link and svg</p><linked>'
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

  it("sees through character references and whitespace in a URL", () => {
    expect(countRemoteImages('<img src="&#104;ttps://tidewater.app/a.png">')).toBe(1);
    expect(countRemoteImages('<img src="https&colon;//tidewater.app/a.png">')).toBe(1);
    expect(countRemoteImages('<img src="ht\ntps://tidewater.app/a.png">')).toBe(1);
    expect(countRemoteImages('<div style="background:u&#114;l(https://x.example/b.png)">')).toBe(1);
  });

  it("counts anything not plainly embedded, and nothing that is", () => {
    // Relative and odd URLs would still load from somewhere.
    expect(countRemoteImages('<img src="logo.png">')).toBe(1);
    expect(countRemoteImages('<img src="  DATA:image/png;base64,AAAA">')).toBe(0);
    expect(
      countRemoteImages('<img srcset="data:image/png;base64,AAAA 1x, https://x.example/a.png 2x">')
    ).toBe(1);
    expect(countRemoteImages('<rect fill="url(#gradient)">')).toBe(0);
  });
});

describe("countImageReferences", () => {
  it("tells parts of the message (cid:) apart from remote images", () => {
    expect(
      countImageReferences(
        '<img src="cid:logo@x"><img src="CID:banner"><img src="https://x.example/a.png"><img src="data:image/png;base64,AA">'
      )
    ).toEqual({ remote: 1, inline: 2 });
  });
});

describe("countImageReferences on hostile input", () => {
  it("scans CSS url() in linear time", () => {
    const size = 256 * 1024;
    for (const html of [
      "url(".repeat(size / 4),
      'url("'.repeat(size / 5),
      "url('".repeat(size / 5),
    ]) {
      const started = performance.now();
      countImageReferences(html);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("counts url() after characters whose lowercase is longer", () => {
    expect(countImageReferences("İİİİ { background: URL(https://x.io/a.png) }")).toEqual({
      remote: 1,
      inline: 0,
    });
  });

  it("reads quoted, unquoted and spaced url() values", () => {
    const html =
      'a { background: url( "https://x.io/a.png" ) } b { background: url(cid:part) }' +
      " c { background: url('data:image/png;base64,AA') } d { background: myurl(https://y.io/z.png) }";
    expect(countImageReferences(html)).toEqual({ remote: 1, inline: 1 });
  });
});
