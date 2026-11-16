import { describe, expect, it } from "vitest";
import { NO_BANNER_PATH_SOURCE } from "./announcements";

describe("NO_BANNER_PATH_SOURCE", () => {
  const noBanner = new RegExp(NO_BANNER_PATH_SOURCE);

  it("keeps the banner off the app and the one-purpose pages", () => {
    for (const path of [
      "/dashboard",
      "/account/billing",
      "/login",
      "/ops",
      "/ops/tickets/12",
      "/approve",
      "/checkout/0b9f6a52-3f43-4c47-9a83-2f7d8a1c5e10",
      "/cli/verify",
      "/oauth/authorize",
      "/agent/claim",
      "/report",
      "/s/token",
    ]) {
      expect(noBanner.test(path), path).toBe(true);
    }
  });

  it("shows it on the public pages", () => {
    for (const path of ["/", "/pricing", "/share", "/docs/cli", "/support-us", "/opsx"]) {
      expect(noBanner.test(path), path).toBe(false);
    }
  });
});
