import { describe, expect, it } from "vitest";
import { loginPathFor } from "./require-auth";

describe("loginPathFor", () => {
  it("keeps the way back for a visitor who arrived signed out", () => {
    expect(loginPathFor("/dashboard?endpoint=abc&request=r1", false)).toBe(
      "/login?redirect=%2Fdashboard%3Fendpoint%3Dabc%26request%3Dr1"
    );
  });

  it("drops it once the page was signed in, and for the home page", () => {
    expect(loginPathFor("/dashboard?endpoint=abc", true)).toBe("/login");
    expect(loginPathFor("/", false)).toBe("/login");
  });
});
