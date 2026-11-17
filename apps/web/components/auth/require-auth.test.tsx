import { describe, expect, it } from "vitest";
import { loginPathFor, signedInHere } from "./require-auth";

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

describe("signedInHere", () => {
  /** Runs the page's states through signedInHere, then the login path it would leave for. */
  function after(states: Array<[isAuthenticated: boolean, sessionChecked: boolean]>) {
    const was = states.reduce(
      (before, [auth, checked]) => signedInHere(before, auth, checked),
      false
    );
    return loginPathFor("/dashboard?endpoint=abc", was);
  }

  it("keeps the way back for a session from the cookie that ended before its check settled", () => {
    // Loaded with the cookie's session, then signed out by the check.
    expect(
      after([
        [true, false],
        [false, false],
        [false, true],
      ])
    ).toBe("/login?redirect=%2Fdashboard%3Fendpoint%3Dabc");
  });

  it("drops it once the page was signed in and checked", () => {
    expect(
      after([
        [true, false],
        [true, true],
        [false, true],
      ])
    ).toBe("/login");
  });

  it("never counts a page that had no session", () => {
    expect(after([[false, true]])).toBe("/login?redirect=%2Fdashboard%3Fendpoint%3Dabc");
  });
});
