import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const register = vi.fn();
const identify = vi.fn();
const reset = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    capture: (...args: unknown[]) => capture(...args),
    register: (...args: unknown[]) => register(...args),
    identify: (...args: unknown[]) => identify(...args),
    reset: (...args: unknown[]) => reset(...args),
  },
}));

// The helpers no-op outside the browser, so give them a window to run in.
vi.stubGlobal("window", {});

const { reportAuthenticatedUser, resetUser, trackUiStyleChanged } = await import("./analytics");

describe("trackUiStyleChanged", () => {
  beforeEach(() => {
    capture.mockClear();
  });

  it("reports the switch and sets the style on the person", () => {
    trackUiStyleChanged({ from: "clean", to: "classic" });
    expect(capture).toHaveBeenCalledWith("ui_style_changed", {
      from: "clean",
      to: "classic",
      $set: { ui_style: "classic" },
    });
  });
});

describe("reportAuthenticatedUser", () => {
  const user = {
    id: "user-1",
    email: "new@example.com",
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    app_metadata: { provider: "github" },
  };
  const oldUser = { ...user, created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() };

  function browser(cookie: string) {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    let jar = cookie;
    vi.stubGlobal("document", {
      get cookie() {
        return jar;
      },
      set cookie(value: string) {
        jar = value.includes("Max-Age=0") ? "" : value;
      },
    });
  }

  beforeEach(() => {
    capture.mockClear();
    identify.mockClear();
    resetUser();
  });

  it("identifies the person and records the signup the auth routes flagged", () => {
    browser("whk_signup=1");
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledWith("user-1", { email: "new@example.com" });
    expect(capture).toHaveBeenCalledWith("account_created", {
      provider: "github",
      signal: "confirmed",
    });
  });

  it("identifies a returning sign-in without recording a signup", () => {
    browser("theme=dark");
    reportAuthenticatedUser(oldUser);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("still records a signup when GoTrue's fallback link skipped our auth routes", () => {
    browser("theme=dark");
    reportAuthenticatedUser(user);
    expect(capture).toHaveBeenCalledWith("account_created", {
      provider: "github",
      signal: "new_account",
    });
  });

  it("does nothing on repeat calls for the same user", () => {
    browser("whk_signup=1");
    reportAuthenticatedUser(user);
    reportAuthenticatedUser(user);
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("identifies again after a sign out", () => {
    browser("theme=dark");
    reportAuthenticatedUser(user);
    resetUser();
    reportAuthenticatedUser(user);
    expect(identify).toHaveBeenCalledTimes(2);
  });
});
