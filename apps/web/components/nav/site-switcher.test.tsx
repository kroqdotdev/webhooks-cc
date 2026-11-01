import { describe, expect, it } from "vitest";
import { switchNextPath } from "./site-switcher";

describe("switchNextPath", () => {
  it("keeps an app page and its query, both sites serve those", () => {
    expect(switchNextPath("/dashboard", "?endpoint=acme")).toBe("/dashboard?endpoint=acme");
    expect(switchNextPath("/account/api-keys", "")).toBe("/account/api-keys");
    expect(switchNextPath("/teams", "")).toBe("/teams");
  });

  it("goes to the other site's home from any other page", () => {
    expect(switchNextPath("/docs/layouts", "")).toBe("/");
    expect(switchNextPath("/pricing", "?x=1")).toBe("/");
    expect(switchNextPath("/dashboards-are-not-this", "")).toBe("/");
  });
});
