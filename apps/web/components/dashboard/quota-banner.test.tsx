import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuotaRejectionDetail } from "./quota-banner";

describe("QuotaRejectionDetail", () => {
  it("renders nothing before any webhook was rejected", () => {
    expect(renderToStaticMarkup(<QuotaRejectionDetail rejections={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <QuotaRejectionDetail rejections={{ total: 0, endpointCount: 0, endpoints: [] }} />
      )
    ).toBe("");
  });

  it("names the total and each affected endpoint", () => {
    const html = renderToStaticMarkup(
      <QuotaRejectionDetail
        rejections={{
          total: 1420,
          endpointCount: 2,
          endpoints: [
            { slug: "stripe-prod", rejected: 1000 },
            { slug: "gh-staging", rejected: 420 },
          ],
        }}
      />
    );
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe(
      "1,420 webhooks rejected this period on stripe-prod (1,000), gh-staging (420)."
    );
    expect(html).toContain('<code class="font-mono">stripe-prod</code>');
  });

  it("uses singular wording and summarizes unlisted endpoints", () => {
    const one = renderToStaticMarkup(
      <QuotaRejectionDetail
        rejections={{ total: 1, endpointCount: 1, endpoints: [{ slug: "solo", rejected: 1 }] }}
      />
    ).replace(/<[^>]+>/g, "");
    expect(one).toBe("1 webhook rejected this period on solo (1).");

    const many = renderToStaticMarkup(
      <QuotaRejectionDetail
        rejections={{ total: 9, endpointCount: 4, endpoints: [{ slug: "a", rejected: 9 }] }}
      />
    ).replace(/<[^>]+>/g, "");
    expect(many).toBe("9 webhooks rejected this period on a (9) and 3 more endpoints.");
  });

  it("escapes slugs", () => {
    const html = renderToStaticMarkup(
      <QuotaRejectionDetail
        rejections={{
          total: 1,
          endpointCount: 1,
          endpoints: [{ slug: "<script>x</script>", rejected: 1 }],
        }}
      />
    );
    expect(html).not.toContain("<script>");
  });
});
