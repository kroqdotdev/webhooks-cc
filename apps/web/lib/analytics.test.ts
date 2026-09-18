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

const {
  applyStyleExperiment,
  registerStyleVariant,
  reportAuthenticatedUser,
  resetUser,
  trackAccountCreated,
  trackStyleExposure,
  trackUiStyleChanged,
} = await import("./analytics");

/**
 * The property names matter: PostHog's experiment results read $feature/<key>
 * off every event and count participants from $feature_flag_called.
 */
describe("visual style experiment events", () => {
  beforeEach(() => {
    capture.mockClear();
    register.mockClear();
  });

  it("registers the assigned variant as the experiment property", () => {
    registerStyleVariant("clean");
    expect(register).toHaveBeenCalledWith({ "$feature/ui-style": "clean" });
  });

  it("sends an exposure PostHog can count", () => {
    trackStyleExposure("clean", "classic");
    expect(capture).toHaveBeenCalledWith("$feature_flag_called", {
      $feature_flag: "ui-style",
      $feature_flag_response: "clean",
      ui_style_active: "classic",
    });
  });

  it("reports a switch away from the assigned style", () => {
    trackUiStyleChanged({
      from: "clean",
      to: "classic",
      sourceBefore: "assigned",
      assigned: "clean",
    });
    expect(capture).toHaveBeenCalledWith("ui_style_changed", {
      from: "clean",
      to: "classic",
      source_before: "assigned",
      assigned_variant: "clean",
      left_assigned_style: true,
      $set: { ui_style: "classic" },
    });
  });

  it("reports a switch by someone who was never in the experiment", () => {
    trackUiStyleChanged({ from: "classic", to: "clean", sourceBefore: null, assigned: null });
    expect(capture).toHaveBeenCalledWith(
      "ui_style_changed",
      expect.objectContaining({
        source_before: "default",
        assigned_variant: "none",
        left_assigned_style: false,
      })
    );
  });

  it("records the completed signup", () => {
    trackAccountCreated("github");
    expect(capture).toHaveBeenCalledWith("account_created", {
      provider: "github",
      signal: "confirmed",
    });
    trackAccountCreated(undefined, "new_account");
    expect(capture).toHaveBeenCalledWith("account_created", {
      provider: "unknown",
      signal: "new_account",
    });
  });
});

/** The shared auth store calls this on every session change, so it has to be idempotent. */
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

/** posthog.reset() on sign out drops super properties and starts a new identity. */
describe("applyStyleExperiment", () => {
  function browser(storage: Record<string, string>) {
    const local = new Map(Object.entries(storage));
    const session = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    });
  }

  beforeEach(() => {
    capture.mockClear();
    register.mockClear();
    reset.mockClear();
  });

  it("registers the variant and sends one exposure per session", () => {
    browser({ "ui-style": "clean", "ui-style-source": "assigned", "ui-style-assigned": "clean" });
    applyStyleExperiment();
    applyStyleExperiment();
    expect(register).toHaveBeenCalledWith({ "$feature/ui-style": "clean" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      "$feature_flag_called",
      expect.objectContaining({ $feature_flag_response: "clean" })
    );
  });

  it("leaves browsers that were never assigned out of the experiment", () => {
    browser({ "ui-style": "clean", "ui-style-source": "chosen" });
    applyStyleExperiment();
    expect(register).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("restores the variant and exposes the new identity after a sign out", () => {
    browser({
      "ui-style": "classic",
      "ui-style-source": "assigned",
      "ui-style-assigned": "classic",
    });
    applyStyleExperiment();
    register.mockClear();
    capture.mockClear();

    resetUser();

    expect(reset).toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith({ "$feature/ui-style": "classic" });
    expect(capture).toHaveBeenCalledWith(
      "$feature_flag_called",
      expect.objectContaining({ $feature_flag_response: "classic" })
    );
  });
});
