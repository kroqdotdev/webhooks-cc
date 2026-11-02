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

const { acceptAnalytics, declineAnalytics, analyticsConsent } = await import("./analytics-consent");
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
