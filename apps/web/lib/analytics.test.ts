import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const register = vi.fn();
const identify = vi.fn();
const reset = vi.fn();
let consent = "granted";
vi.mock("posthog-js", () => ({
  default: {
    get_explicit_consent_status: () => consent,
    capture: (...args: unknown[]) => capture(...args),
    register: (...args: unknown[]) => register(...args),
    identify: (...args: unknown[]) => identify(...args),
    reset: (...args: unknown[]) => reset(...args),
  },
}));

// The helpers no-op outside the browser, so give them a window to run in.
vi.stubGlobal("window", {});

const { forgetIdentifiedUser, identifyPendingUser, reportAuthenticatedUser, resetUser } =
  await import("./analytics");

describe("reportAuthenticatedUser", () => {
  const user = { id: "user-1" };

  beforeEach(() => {
    capture.mockClear();
    identify.mockClear();
    consent = "granted";
    resetUser();
  });

  it("identifies the person once analytics is accepted", () => {
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledWith("user-1", undefined);
    expect(capture).not.toHaveBeenCalled();
  });

  it("does nothing on repeat calls for the same user", () => {
    reportAuthenticatedUser(user);
    reportAuthenticatedUser(user);
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser anonymous until the visitor accepts, then identifies", () => {
    consent = "pending";
    reportAuthenticatedUser(user);
    expect(identify).not.toHaveBeenCalled();
    consent = "granted";
    identifyPendingUser();
    expect(identify).toHaveBeenCalledWith("user-1", undefined);
  });

  it("never identifies after a decline", () => {
    consent = "denied";
    reportAuthenticatedUser(user);
    identifyPendingUser();
    expect(identify).not.toHaveBeenCalled();
  });

  it("identifies again when the visitor declines and later accepts", () => {
    reportAuthenticatedUser(user);
    consent = "denied";
    forgetIdentifiedUser();
    identifyPendingUser();
    expect(identify).toHaveBeenCalledTimes(1);
    consent = "granted";
    identifyPendingUser();
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it("identifies again after a sign out", () => {
    reportAuthenticatedUser(user);
    resetUser();
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledTimes(2);
  });
});
