import { describe, expect, it } from "vitest";
import { defaultDashboardEndpoint } from "./dashboard-api";

describe("defaultDashboardEndpoint", () => {
  it("opens the first favourite, else the first endpoint", () => {
    const a = { slug: "a" };
    const b = { slug: "b", favorite: true };
    const c = { slug: "c", favorite: true };
    expect(defaultDashboardEndpoint([a, b, c])).toBe(b);
    expect(defaultDashboardEndpoint([a, { slug: "d", favorite: false }])).toBe(a);
    expect(defaultDashboardEndpoint([])).toBeUndefined();
  });
});
