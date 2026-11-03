import { beforeEach, describe, expect, it, vi } from "vitest";

let consent = "pending";
const optIn = vi.fn(() => {
  consent = "granted";
});
const optOut = vi.fn(() => {
  consent = "denied";
});
vi.mock("posthog-js", () => ({
  default: {
    get_explicit_consent_status: () => consent,
    opt_in_capturing: () => optIn(),
    opt_out_capturing: () => optOut(),
    identify: vi.fn(),
    capture: vi.fn(),
    reset: vi.fn(),
  },
}));

const session = new Map<string, string>();
vi.stubGlobal("window", {});
vi.stubGlobal("navigator", {});
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => session.get(key) ?? null,
  setItem: (key: string, value: string) => session.set(key, value),
});

let saved: "granted" | "denied" | null = null;
let readStatus = 200;
const puts: unknown[] = [];
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "PUT") {
    puts.push(JSON.parse(String(init.body)));
    return new Response("{}");
  }
  if (readStatus !== 200) return new Response("{}", { status: readStatus });
  return Response.json({ consent: saved });
});
vi.stubGlobal("fetch", fetchMock);

const { markConsentAnsweredHere, resetAccountConsentSync, syncAccountConsent } =
  await import("./analytics-account-consent");

describe("syncAccountConsent", () => {
  beforeEach(() => {
    consent = "pending";
    saved = null;
    readStatus = 200;
    puts.length = 0;
    session.clear();
    optIn.mockClear();
    optOut.mockClear();
    fetchMock.mockClear();
    resetAccountConsentSync();
  });

  it("answers an unanswered browser with the account's accept", async () => {
    saved = "granted";
    await syncAccountConsent("user-1", "token");
    expect(consent).toBe("granted");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer token" });
  });

  it("leaves a browser that declined alone when the account accepted", async () => {
    saved = "granted";
    consent = "denied";
    await syncAccountConsent("user-1", "token");
    expect(optIn).not.toHaveBeenCalled();
    expect(consent).toBe("denied");
  });

  it("applies the account's decline over a browser that accepted", async () => {
    saved = "denied";
    consent = "granted";
    await syncAccountConsent("user-1", "token");
    expect(consent).toBe("denied");
  });

  it("does not accept for a browser that sends Do Not Track", async () => {
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    saved = "granted";
    await syncAccountConsent("user-1", "token");
    expect(consent).toBe("pending");
    vi.stubGlobal("navigator", {});
  });

  it("saves this browser's decline on an account without a choice", async () => {
    consent = "denied";
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "denied" }]);
  });

  it("saves an accept only when it was given in this tab", async () => {
    consent = "granted";
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([]);

    resetAccountConsentSync();
    markConsentAnsweredHere();
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "granted" }]);
  });

  it("saves nothing while neither has answered", async () => {
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([]);
    expect(consent).toBe("pending");
  });

  it("asks the account once per user and page load", async () => {
    saved = "granted";
    await Promise.all([syncAccountConsent("user-1", "t"), syncAccountConsent("user-1", "t")]);
    await syncAccountConsent("user-1", "t");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await syncAccountConsent("user-2", "t");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves and changes nothing when the account cannot be read", async () => {
    readStatus = 500;
    await expect(syncAccountConsent("user-1", "token")).resolves.toBeUndefined();
    expect(consent).toBe("pending");
  });
});
