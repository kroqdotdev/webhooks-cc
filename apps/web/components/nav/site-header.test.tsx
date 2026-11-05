import { describe, expect, it } from "vitest";
import { headerPlace } from "./site-header";

describe("headerPlace", () => {
  it("knows the sign-in and auth pages", () => {
    expect(headerPlace("/login").onAuthPage).toBe(true);
    expect(headerPlace("/auth/confirm").onAuthPage).toBe(true);
    expect(headerPlace("/auth/switch/finish").onAuthPage).toBe(true);
  });

  it("knows the app pages and their subpages", () => {
    expect(headerPlace("/dashboard").inApp).toBe(true);
    expect(headerPlace("/account/api-keys").inApp).toBe(true);
    expect(headerPlace("/teams").inApp).toBe(true);
  });

  it("does not match a page that only starts with the same letters", () => {
    expect(headerPlace("/loginlog-in")).toEqual({ onAuthPage: false, inApp: false });
    expect(headerPlace("/auth.md")).toEqual({ onAuthPage: false, inApp: false });
    expect(headerPlace("/auth")).toEqual({ onAuthPage: false, inApp: false });
    expect(headerPlace("/dashboards")).toEqual({ onAuthPage: false, inApp: false });
    expect(headerPlace("/accounts")).toEqual({ onAuthPage: false, inApp: false });
    expect(headerPlace("/")).toEqual({ onAuthPage: false, inApp: false });
  });
});
