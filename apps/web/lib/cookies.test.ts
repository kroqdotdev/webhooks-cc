import { describe, expect, it } from "vitest";
import { cookieValue } from "./cookies";

describe("cookieValue", () => {
  it("finds a cookie among others, keeping '=' inside its value", () => {
    expect(cookieValue("a=1; whcc=abc=def; b=2", "whcc")).toBe("abc=def");
  });

  it("matches the whole name only", () => {
    expect(cookieValue("__Host-whcc=1; whcc_other=2", "whcc")).toBeNull();
  });

  it("is null for a missing header, a missing cookie or an empty value", () => {
    expect(cookieValue(null, "whcc")).toBeNull();
    expect(cookieValue("a=1", "whcc")).toBeNull();
    expect(cookieValue("whcc=; a=1", "whcc")).toBeNull();
  });
});
