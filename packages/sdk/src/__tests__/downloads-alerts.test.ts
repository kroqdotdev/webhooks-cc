import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhooksCC } from "../client";

const BASE_URL = "https://webhooks.example";

function client(fetchImpl: typeof fetch) {
  return new WebhooksCC({ apiKey: "whcc_test", baseUrl: BASE_URL, fetch: fetchImpl });
}

afterEach(() => vi.restoreAllMocks());

describe("downloads", () => {
  it("returns an attachment's bytes, name and type", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${BASE_URL}/api/requests/req-1/attachments/2`);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer whcc_test");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename="r_sum_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`,
        },
      });
    });
    const download = await client(fetchImpl as unknown as typeof fetch).requests.attachment(
      "req-1",
      2
    );
    expect(Array.from(download.bytes)).toEqual([1, 2, 3]);
    expect(download.filename).toBe("résumé.csv");
    expect(download.contentType).toBe("text/csv");
  });

  it("returns a raw message and maps errors", async () => {
    const ok = vi.fn(async () => new Response("Subject: x\r\n\r\nbody"));
    const raw = await client(ok as unknown as typeof fetch).requests.raw("req-1");
    expect(new TextDecoder().decode(raw)).toContain("Subject: x");

    const gone = vi.fn(async () => new Response('{"error":"not_kept"}', { status: 404 }));
    await expect(client(gone as unknown as typeof fetch).requests.raw("req-1")).rejects.toThrow();
    await expect(
      client(ok as unknown as typeof fetch).requests.attachment("req-1", 100)
    ).rejects.toThrow(/index/);
  });
});

describe("redelivery and alerts", () => {
  it("posts redeliveries and reads and writes alert settings", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      const path = String(url).replace(`${BASE_URL}/api`, "");
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (path === "/requests/req-1/replay") return json({ queued: true });
      if (path === "/endpoints/orders/replay") return json({ requests: 3, queued: 3 });
      if (path === "/endpoints/orders/alerts" && init?.method === "PUT") {
        return json({ settings: { ...body, enabled: true } });
      }
      return json({ settings: { enabled: false }, events: [] });
    });
    const c = client(fetchImpl as unknown as typeof fetch);
    expect(await c.requests.redeliver("req-1")).toBe(true);
    expect(await c.endpoints.redeliver("orders", { since: 1, kind: "email" })).toEqual({
      requests: 3,
      queued: 3,
    });
    expect((await c.alerts.get("orders")).events).toEqual([]);
    expect((await c.alerts.update("orders", { silenceHours: 6 })).silenceHours).toBe(6);
    expect(calls.map((call) => `${call.method} ${call.url.replace(BASE_URL, "")}`)).toEqual([
      "POST /api/requests/req-1/replay",
      "POST /api/endpoints/orders/replay",
      "GET /api/endpoints/orders/alerts",
      "PUT /api/endpoints/orders/alerts",
    ]);
    expect(calls[1].body).toEqual({ since: 1, kind: "email" });
  });
});
