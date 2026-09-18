import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeSignupSignal, SIGNUP_SIGNAL_COOKIE } from "./signup-signal";

/** A document stub whose cookie jar behaves like the browser's for our two operations. */
function fakeDocument(initial: string) {
  let jar = initial;
  return {
    get cookie() {
      return jar;
    },
    set cookie(value: string) {
      jar = value.includes("Max-Age=0") ? "" : value;
    },
  };
}

describe("consumeSignupSignal", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("reports the signal once and clears it", () => {
    const doc = fakeDocument(`${SIGNUP_SIGNAL_COOKIE}=1`);
    vi.stubGlobal("document", doc);
    expect(consumeSignupSignal()).toBe(true);
    expect(doc.cookie).toBe("");
    expect(consumeSignupSignal()).toBe(false);
  });

  it("ignores other cookies and leaves them alone", () => {
    const doc = fakeDocument("sb-ref-auth-token=abc; theme=dark");
    vi.stubGlobal("document", doc);
    expect(consumeSignupSignal()).toBe(false);
    expect(doc.cookie).toBe("sb-ref-auth-token=abc; theme=dark");
  });

  it("finds the signal next to other cookies", () => {
    vi.stubGlobal("document", fakeDocument(`theme=dark; ${SIGNUP_SIGNAL_COOKIE}=1; other=x`));
    expect(consumeSignupSignal()).toBe(true);
  });

  it("does nothing on the server", () => {
    vi.stubGlobal("document", undefined);
    expect(consumeSignupSignal()).toBe(false);
  });
});
