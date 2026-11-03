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

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}
const session = memoryStorage();
const local = memoryStorage();
vi.stubGlobal("window", {});
vi.stubGlobal("navigator", {});
vi.stubGlobal("sessionStorage", session);
vi.stubGlobal("localStorage", local);

let saved: "granted" | "denied" | null = null;
let savedAt: string | null = null;
let readStatus = 200;
let putStatus = 200;
/** Our server's clock minus this browser's. */
let serverOffset = 0;
/** When set, a PUT waits for it. */
let putGate: Promise<void> | null = null;
/** When set, the account read waits for it. */
let readGate: Promise<void> | null = null;
const puts: unknown[] = [];
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "PUT") {
    puts.push(JSON.parse(String(init.body)));
    if (putGate) await putGate;
    return new Response("{}", { status: putStatus });
  }
  if (readGate) await readGate;
  if (readStatus !== 200) return new Response("{}", { status: readStatus });
  return Response.json({
    consent: saved,
    savedAt,
    now: new Date(Date.now() + serverOffset).toISOString(),
  });
});
vi.stubGlobal("fetch", fetchMock);

const {
  endAccountConsentSession,
  markConsentAnsweredHere,
  resetAccountConsentSync,
  saveAccountConsent,
  syncAccountConsent,
} = await import("./analytics-account-consent");

function gate() {
  let open = () => {};
  readGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    readGate = null;
    open();
  };
}

describe("syncAccountConsent", () => {
  beforeEach(() => {
    consent = "pending";
    saved = null;
    savedAt = null;
    readStatus = 200;
    putStatus = 200;
    readGate = null;
    putGate = null;
    serverOffset = 0;
    puts.length = 0;
    session.map.clear();
    local.map.clear();
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

  it("does not save a decline that only Do Not Track made", async () => {
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    consent = "denied";
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([]);
    vi.stubGlobal("navigator", {});
  });

  it("drops an account read when the visitor answers while it is pending", async () => {
    saved = "denied";
    consent = "granted";
    const open = gate();
    const sync = syncAccountConsent("user-1", "token");
    markConsentAnsweredHere();
    open();
    await sync;
    expect(optOut).not.toHaveBeenCalled();
    expect(consent).toBe("granted");
  });

  it("drops an account read when the session ends while it is pending", async () => {
    saved = "granted";
    const open = gate();
    const sync = syncAccountConsent("user-1", "token");
    endAccountConsentSession();
    open();
    await sync;
    expect(consent).toBe("pending");
  });

  it("clears the same-tab marker when the session ends", async () => {
    markConsentAnsweredHere();
    endAccountConsentSession();
    consent = "granted";
    await syncAccountConsent("user-2", "token");
    expect(puts).toEqual([]);
  });

  it("sends a failed decline again on the next page load, even over an older accept", async () => {
    putStatus = 500;
    expect(await saveAccountConsent("user-1", "token", "denied", 2_000)).toBe(false);
    consent = "denied";

    resetAccountConsentSync();
    putStatus = 200;
    saved = "granted";
    savedAt = new Date(1_000).toISOString();
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "denied" }, { consent: "denied" }]);
    expect(local.map.size).toBe(0);
  });

  it("drops an unsaved choice once the account holds a newer one", async () => {
    putStatus = 500;
    await saveAccountConsent("user-1", "token", "granted", 1_000);
    consent = "granted";

    resetAccountConsentSync();
    putStatus = 200;
    saved = "denied";
    savedAt = new Date(2_000).toISOString();
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "granted" }]);
    expect(consent).toBe("denied");
    expect(local.map.size).toBe(0);
  });

  it("keeps another account's unsaved choice to itself", async () => {
    putStatus = 500;
    await saveAccountConsent("user-1", "token", "denied", 1_000);
    resetAccountConsentSync();
    putStatus = 200;
    await syncAccountConsent("user-2", "token");
    expect(puts).toEqual([{ consent: "denied" }]);
  });

  it("sends saves in the order they were made", async () => {
    const first = saveAccountConsent("user-1", "token", "granted");
    const second = saveAccountConsent("user-1", "token", "denied");
    await Promise.all([first, second]);
    expect(puts).toEqual([{ consent: "granted" }, { consent: "denied" }]);
  });

  it("keeps a choice made without a token and sends it on the next page load", async () => {
    expect(await saveAccountConsent("user-1", async () => null, "denied")).toBe(false);
    expect(puts).toEqual([]);
    consent = "denied";

    resetAccountConsentSync();
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "denied" }]);
    expect(local.map.size).toBe(0);
  });

  it("keeps the latest click even when the page closes behind a save in flight", async () => {
    let open = () => {};
    putGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    void saveAccountConsent("user-1", "token", "denied", 1_000);
    void saveAccountConsent("user-1", "token", "granted", 2_000);
    // Only the first request has left; the page could close here.
    expect(JSON.parse(local.map.get("whk_consent_unsaved")!)).toMatchObject({
      consent: "granted",
      at: 2_000,
    });
    open();
  });

  it("compares an unsent choice with the account on the server's clock", async () => {
    const now = Date.now();
    // This browser's clock runs ten minutes fast.
    serverOffset = -10 * 60_000;
    putStatus = 500;
    // Declined five minutes ago, noted on this browser's clock.
    await saveAccountConsent("user-1", "token", "denied", now - 5 * 60_000);
    consent = "denied";

    resetAccountConsentSync();
    putStatus = 200;
    // Another browser accepted three minutes ago, noted on ours: the newer
    // choice, though its raw timestamp is the smaller one.
    saved = "granted";
    savedAt = new Date(now + serverOffset - 3 * 60_000).toISOString();
    await syncAccountConsent("user-1", "token");
    expect(puts).toEqual([{ consent: "denied" }]);
    expect(local.map.size).toBe(0);
  });
});
