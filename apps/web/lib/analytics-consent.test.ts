import { beforeEach, describe, expect, it, vi } from "vitest";

let consent = "pending";
const optIn = vi.fn(() => {
  consent = "granted";
});
const optOut = vi.fn(() => {
  consent = "denied";
});
const identify = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    get_explicit_consent_status: () => consent,
    opt_in_capturing: () => optIn(),
    opt_out_capturing: () => optOut(),
    identify: (...args: unknown[]) => identify(...args),
    capture: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.stubGlobal("window", {});

const { acceptAnalytics, analyticsConsent, applyCarriedConsent, declineAnalytics } =
  await import("./analytics-consent");
const { clearPendingUser, identifyUser, reportAuthenticatedUser, resetUser } =
  await import("./analytics");

describe("analytics consent", () => {
  beforeEach(() => {
    consent = "pending";
    optIn.mockClear();
    optOut.mockClear();
    identify.mockClear();
    resetUser();
  });

  it("opts PostHog in on accept and identifies the waiting user with their profile", () => {
    reportAuthenticatedUser({ id: "user-1" });
    identifyUser("user-1", { plan: "pro" });
    expect(identify).not.toHaveBeenCalled();
    acceptAnalytics();
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(analyticsConsent()).toBe("granted");
    expect(identify).toHaveBeenCalledWith("user-1", { plan: "pro" });
  });

  it("opts out on decline", () => {
    declineAnalytics();
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(analyticsConsent()).toBe("denied");
  });

  it("does not identify a former session's account on a later accept", () => {
    reportAuthenticatedUser({ id: "user-1" });
    clearPendingUser();
    acceptAnalytics();
    expect(identify).not.toHaveBeenCalled();
  });
});

describe("consent carried from the other site", () => {
  let cookies: string[];
  function visit(protocol: "https:" | "http:", cookie: string, doNotTrack = "0") {
    cookies = [];
    vi.stubGlobal("window", { location: { protocol } });
    vi.stubGlobal("navigator", { doNotTrack });
    vi.stubGlobal("document", {
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        cookies.push(value);
      },
    });
  }

  beforeEach(() => {
    consent = "pending";
    optIn.mockClear();
    optOut.mockClear();
  });

  it("answers a banner not yet answered here, and clears the cookie", () => {
    visit("https:", "theme=dark; __Host-whk_consent_carry=granted");
    applyCarriedConsent();
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(cookies).toEqual(["__Host-whk_consent_carry=; Path=/; Max-Age=0; SameSite=Lax; Secure"]);
  });

  it("never overrides a decline made here with an accept, but a decline always applies", () => {
    consent = "denied";
    visit("https:", "__Host-whk_consent_carry=granted");
    applyCarriedConsent();
    expect(optIn).not.toHaveBeenCalled();

    consent = "granted";
    visit("https:", "__Host-whk_consent_carry=denied");
    applyCarriedConsent();
    expect(optOut).toHaveBeenCalledTimes(1);
  });

  it("ignores a cookie without the __Host- prefix over https, and Do Not Track wins", () => {
    visit("https:", "whk_consent_carry=granted");
    applyCarriedConsent();
    expect(optIn).not.toHaveBeenCalled();
    expect(cookies).toEqual([]);

    visit("https:", "__Host-whk_consent_carry=granted", "1");
    applyCarriedConsent();
    expect(optIn).not.toHaveBeenCalled();
  });

  it("keeps a carried decline that storage refused, for the next page to retry", () => {
    consent = "granted";
    optOut.mockImplementationOnce(() => {});
    visit("https:", "__Host-whk_consent_carry=denied");
    applyCarriedConsent();
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(cookies).toEqual([]);
  });

  it("reads the plain cookie in local development over http", () => {
    visit("http:", "whk_consent_carry=granted");
    applyCarriedConsent();
    expect(optIn).toHaveBeenCalledTimes(1);
  });
});
