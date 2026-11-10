import { describe, expect, it } from "vitest";
import { sitePath } from "./site-pathname";

describe("sitePath", () => {
  it("drops the app/mailhooks prefix the host rewrites add", () => {
    expect(sitePath("/mailhooks")).toBe("/");
    expect(sitePath("/mailhooks/pricing")).toBe("/pricing");
    expect(sitePath("/mailhooks/docs/layouts")).toBe("/docs/layouts");
  });

  it("leaves every other path alone", () => {
    expect(sitePath("/")).toBe("/");
    expect(sitePath("/docs/layouts")).toBe("/docs/layouts");
    expect(sitePath("/mailhooksy")).toBe("/mailhooksy");
  });
});
