import { describe, expect, it, vi } from "vitest";
import {
  createSessionCheck,
  isApiUnauthorized,
  watchApiUnauthorized,
  type SessionAuth,
} from "./session-check";

function auth(error: { code?: string } | null = null) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fake = {
    getUser: vi.fn(async () => {
      await gate;
      return { error };
    }),
    signOut: vi.fn(async () => ({})),
  } satisfies SessionAuth;
  return { fake, release };
}

describe("createSessionCheck", () => {
  it("signs out locally when GoTrue no longer knows the user", async () => {
    const { fake, release } = auth({ code: "user_not_found" });
    const check = createSessionCheck(fake);
    const done = check();
    release();
    await done;
    expect(fake.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("leaves the session alone for anything else: auth-js clears a missing session itself", async () => {
    for (const error of [
      null,
      { code: "session_not_found" },
      { code: undefined },
      { code: "unexpected_failure" },
    ]) {
      const { fake, release } = auth(error);
      const done = createSessionCheck(fake)();
      release();
      await done;
      expect(fake.signOut).not.toHaveBeenCalled();
    }
  });

  it("says nothing about the session when the check itself fails", async () => {
    const fake: SessionAuth = {
      getUser: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      signOut: vi.fn(async () => ({})),
    };
    await expect(createSessionCheck(fake)()).resolves.toBeUndefined();
    expect(fake.signOut).not.toHaveBeenCalled();
  });

  it("runs one check at a time and at most once per interval", async () => {
    let clock = 0;
    const { fake, release } = auth();
    const check = createSessionCheck(fake, { now: () => clock, minIntervalMs: 30_000 });

    const first = check();
    const second = check();
    expect(second).toBe(first);
    release();
    await first;

    clock = 10_000;
    await check();
    expect(fake.getUser).toHaveBeenCalledTimes(1);

    clock = 30_000;
    await check();
    expect(fake.getUser).toHaveBeenCalledTimes(2);
  });
});

describe("isApiUnauthorized", () => {
  const origin = "https://webhooks.cc";
  const status = (n: number) => new Response(null, { status: n });

  it("is a 401 from our own API", () => {
    expect(isApiUnauthorized("/api/endpoints", status(401), origin)).toBe(true);
    expect(isApiUnauthorized("https://webhooks.cc/api/x?y=1", status(401), origin)).toBe(true);
    expect(isApiUnauthorized(new URL("/api", origin), status(401), origin)).toBe(true);
    expect(isApiUnauthorized(new Request("https://webhooks.cc/api/a"), status(401), origin)).toBe(
      true
    );
  });

  it("is nothing else", () => {
    expect(isApiUnauthorized("/api/endpoints", status(403), origin)).toBe(false);
    expect(isApiUnauthorized("/api/endpoints", status(200), origin)).toBe(false);
    // Pages, other origins (Supabase itself) and look-alike paths.
    expect(isApiUnauthorized("/dashboard", status(401), origin)).toBe(false);
    expect(isApiUnauthorized("/apiary", status(401), origin)).toBe(false);
    expect(isApiUnauthorized("https://api1.webhooks.cc/auth/v1/user", status(401), origin)).toBe(
      false
    );
  });
});

describe("watchApiUnauthorized", () => {
  function fakeWindow(answer: Response) {
    const original = vi.fn(async () => answer);
    const win = { fetch: original, location: { origin: "https://webhooks.cc" } };
    return { win: win as unknown as Window, original };
  }

  it("passes the request and the response through, and reports a 401", async () => {
    const answer = new Response("{}", { status: 401 });
    const { win, original } = fakeWindow(answer);
    const seen = vi.fn();
    watchApiUnauthorized(win, seen);

    const init = { headers: { authorization: "Bearer x" } };
    const response = await win.fetch("/api/endpoints", init);
    expect(response).toBe(answer);
    expect(original).toHaveBeenCalledWith("/api/endpoints", init);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("wraps once, and a failing callback never reaches the caller", async () => {
    const answer = new Response(null, { status: 401 });
    const { win } = fakeWindow(answer);
    watchApiUnauthorized(win, () => {
      throw new Error("boom");
    });
    const wrapped = win.fetch;
    watchApiUnauthorized(win, () => {});
    expect(win.fetch).toBe(wrapped);
    await expect(win.fetch("/api/endpoints")).resolves.toBe(answer);
  });
});
