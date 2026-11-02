import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";

const BASE_URL = "https://webhooks.example";

function capture() {
  const seen: Headers[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return Response.json([]);
  });
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("User-Agent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the SDK on API calls", async () => {
    const { seen, fetchImpl } = capture();
    await new WebhooksCC({
      apiKey: "whcc_test",
      baseUrl: BASE_URL,
      fetch: fetchImpl,
    }).endpoints.list();
    expect(seen[0].get("user-agent")).toMatch(/^webhooks-cc-sdk\/\S+$/);
    expect(seen[0].get("authorization")).toBe("Bearer whcc_test");
  });

  it("names the SDK on downloads", async () => {
    const seen: Headers[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("bytes", { headers: { "content-type": "message/rfc822" } });
    }) as unknown as typeof fetch;
    const client = new WebhooksCC({ apiKey: "whcc_test", baseUrl: BASE_URL, fetch: fetchImpl });
    await client.requests.raw("req-1");
    await client.requests.attachment("req-1", 0);
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get("user-agent")).toMatch(/^webhooks-cc-sdk\/\S+$/);
    }
  });

  it("refuses a product token fetch would refuse", () => {
    for (const userAgent of ["acme\r\nX-Evil: 1", "acme\n", "acme\0tool"]) {
      expect(() => new WebhooksCC({ apiKey: "whcc_test", userAgent: ` ${userAgent}x` })).toThrow(
        /userAgent/
      );
    }
  });

  it("puts the caller's product token first", async () => {
    const { seen, fetchImpl } = capture();
    await new WebhooksCC({
      apiKey: "whcc_test",
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      userAgent: "acme-tool/2.0",
    }).endpoints.list();
    expect(seen[0].get("user-agent")).toMatch(/^acme-tool\/2\.0 webhooks-cc-sdk\/\S+$/);
  });

  it("leaves a browser's own User-Agent alone", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    const { seen, fetchImpl } = capture();
    await new WebhooksCC({
      apiKey: "whcc_test",
      baseUrl: BASE_URL,
      fetch: fetchImpl,
      userAgent: "acme-tool/2.0",
    }).endpoints.list();
    expect(seen[0].has("user-agent")).toBe(false);
  });
});
