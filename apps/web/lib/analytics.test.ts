import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const register = vi.fn();
vi.mock("posthog-js", () => ({
  default: {
    capture: (...args: unknown[]) => capture(...args),
    register: (...args: unknown[]) => register(...args),
  },
}));

// The helpers no-op outside the browser, so give them a window to run in.
vi.stubGlobal("window", {});

const { registerStyleVariant, trackAccountCreated, trackStyleExposure, trackUiStyleChanged } =
  await import("./analytics");

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
    expect(capture).toHaveBeenCalledWith("account_created", { provider: "github" });
    trackAccountCreated(undefined);
    expect(capture).toHaveBeenCalledWith("account_created", { provider: "unknown" });
  });
});
