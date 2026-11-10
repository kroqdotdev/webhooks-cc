import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durationText,
  listShares,
  setNamePassword,
  SharesApiError,
  splitShares,
  usagePercent,
  type ApiShare,
} from "./shares-api";

function share(id: string, startedAt: string, endedAt: string | null): ApiShare {
  return {
    id,
    kind: "share",
    name: id,
    url: `https://${id}.sharehooks.cc`,
    endpointSlug: null,
    client: "laptop, Linux",
    startedAt,
    endedAt,
    endReason: null,
    expiresAt: null,
    bytes: 0,
    requests: 0,
    password: false,
    mine: true,
    startedBy: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("splitShares", () => {
  it("puts live ones first, each newest first", () => {
    const { live, ended } = splitShares([
      share("a", "2026-11-10T10:00:00Z", "2026-11-10T11:00:00Z"),
      share("b", "2026-11-10T12:00:00Z", null),
      share("c", "2026-11-10T13:00:00Z", null),
      share("d", "2026-11-10T14:00:00Z", "2026-11-10T15:00:00Z"),
    ]);
    expect(live.map((s) => s.id)).toEqual(["c", "b"]);
    expect(ended.map((s) => s.id)).toEqual(["d", "a"]);
  });
});

describe("usagePercent", () => {
  it("rounds and caps", () => {
    const usage = { month: "2026-11", over: false, resetsAt: "" };
    expect(usagePercent({ ...usage, bytes: 250, limitBytes: 1000 })).toBe(25);
    expect(usagePercent({ ...usage, bytes: 5000, limitBytes: 1000 })).toBe(100);
    expect(usagePercent({ ...usage, bytes: 0, limitBytes: 0 })).toBe(100);
  });
});

describe("durationText", () => {
  it("words minutes, hours and days", () => {
    const from = "2026-11-10T10:00:00Z";
    expect(durationText(from, "2026-11-10T10:18:00Z")).toBe("18 min");
    expect(durationText(from, "2026-11-10T12:05:00Z")).toBe("2 h 5 min");
    expect(durationText(from, "2026-11-10T13:00:00Z")).toBe("3 h");
    expect(durationText(from, "2026-11-14T10:00:00Z")).toBe("4 d");
    expect(durationText(from, null, Date.parse("2026-11-10T10:30:00Z"))).toBe("30 min");
  });
});

describe("calls", () => {
  it("sends the bearer token and turns errors into SharesApiError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Sharing is not set up" }), { status: 503 })
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(listShares("tok")).rejects.toMatchObject({
      name: "SharesApiError",
      status: 503,
      message: "Sharing is not set up",
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(SharesApiError).toBeDefined();
  });

  it("clears a password with DELETE and sets one with PUT", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true, password: false })));
    vi.stubGlobal("fetch", fetchMock);
    await setNamePassword("tok", "acme-demo", null);
    await setNamePassword("tok", "acme-demo", "correct-horse");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tunnel-names/acme-demo/password");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ password: "correct-horse" });
  });
});
