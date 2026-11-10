import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchSite } from "./site-switch-client";

describe("switchSite, signed out", () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://webhooks.cc");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "https://mailhooks.cc");
    vi.stubGlobal("window", { location: { assign } });
  });

  afterEach(() => {
    assign.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("opens the same public page on the other site", async () => {
    await switchSite("mailhooks", "/pricing", null);
    expect(assign).toHaveBeenCalledWith("https://mailhooks.cc/pricing");
    await switchSite("webhooks", "/", null);
    expect(assign).toHaveBeenLastCalledWith("https://webhooks.cc/");
    await switchSite("webhooks", "/docs/layouts", null);
    expect(assign).toHaveBeenLastCalledWith("https://webhooks.cc/docs/layouts");
  });

  it("goes through sign-in on the way to an app page", async () => {
    await switchSite("mailhooks", "/dashboard", undefined);
    expect(assign).toHaveBeenCalledWith("https://mailhooks.cc/login?redirect=%2Fdashboard");
  });
});
