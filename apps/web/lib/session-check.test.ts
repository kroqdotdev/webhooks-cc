import { describe, expect, it, vi } from "vitest";
import {
  createSessionCheck,
  isApiUnauthorized,
  loadSession,
  startSessionChecks,
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
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const { fake, release } = auth();
    const check = createSessionCheck(fake, {
      now: () => clock,
      minIntervalMs: 30_000,
      schedule: (run, ms) => scheduled.push({ run, ms }),
    });

    const first = check();
    const second = check();
    expect(second).toBe(first);
    release();
    await first;

    clock = 30_000;
    await check();
    expect(fake.getUser).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(0);
  });

  it("runs a check asked for inside the interval once the interval ends", async () => {
    // The load-time check passed, then the session was revoked and a 401
    // came in 10 s later: that must not wait for yet another 401.
    let clock = 0;
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const { fake, release } = auth();
    release();
    const check = createSessionCheck(fake, {
      now: () => clock,
      minIntervalMs: 30_000,
      schedule: (run, ms) => scheduled.push({ run, ms }),
    });
    await check();

    clock = 10_000;
    await check();
    await check();
    expect(fake.getUser).toHaveBeenCalledTimes(1);
    // Several asks inside the interval: one check, when it ends.
    expect(scheduled).toEqual([{ run: expect.any(Function), ms: 20_000 }]);

    clock = 30_000;
    scheduled[0].run();
    await Promise.resolve();
    expect(fake.getUser).toHaveBeenCalledTimes(2);
  });

  it("still checks after a check that failed, once the interval ends", async () => {
    let clock = 0;
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const fake: SessionAuth = {
      getUser: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue({ error: { code: "user_not_found" } }),
      signOut: vi.fn(async () => ({})),
    };
    const check = createSessionCheck(fake, {
      now: () => clock,
      minIntervalMs: 30_000,
      schedule: (run, ms) => scheduled.push({ run, ms }),
    });
    await check();
    clock = 5_000;
    await check();
    clock = 30_000;
    scheduled[0].run();
    await vi.waitFor(() => expect(fake.signOut).toHaveBeenCalledWith({ scope: "local" }));
  });
});

describe("createSessionCheck: the trailing check", () => {
  function setup() {
    let clock = 0;
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    let release: () => void = () => {};
    const fake: SessionAuth = {
      getUser: vi.fn(
        () =>
          new Promise<{ error: null }>((resolve) => {
            release = () => resolve({ error: null });
          })
      ),
      signOut: vi.fn(async () => ({})),
    };
    const check = createSessionCheck(fake, {
      now: () => clock,
      minIntervalMs: 30_000,
      schedule: (run, ms) => scheduled.push({ run, ms }),
    });
    return {
      fake,
      check,
      scheduled,
      setClock: (t: number) => (clock = t),
      release: () => release(),
    };
  }

  it("schedules nothing for an ask while a check is running", async () => {
    const t = setup();
    const running = t.check();
    // An ask meanwhile shares the running check rather than scheduling one.
    expect(t.check()).toBe(running);
    expect(t.scheduled).toHaveLength(0);
    t.release();
    await running;
  });

  it("runs a second trailing cycle after the first one fired", async () => {
    const t = setup();
    const first = t.check();
    t.release();
    await first;
    t.setClock(10_000);
    await t.check();
    t.setClock(30_000);
    t.scheduled[0].run();
    t.release();
    // Let the trailing check finish before asking again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.fake.getUser).toHaveBeenCalledTimes(2);

    t.setClock(40_000);
    await t.check();
    expect(t.scheduled).toHaveLength(2);
    expect(t.scheduled[1].ms).toBe(20_000);
  });

  it("re-arms once when its timer fires early", async () => {
    const t = setup();
    const first = t.check();
    t.release();
    await first;
    t.setClock(10_000);
    await t.check();
    t.setClock(20_000); // fired 10 s early
    t.scheduled[0].run();
    expect(t.fake.getUser).toHaveBeenCalledTimes(1);
    expect(t.scheduled).toHaveLength(2);
    expect(t.scheduled[1].ms).toBe(10_000);
  });

  it("never waits longer than the interval, whatever the clock did", async () => {
    const t = setup();
    t.setClock(10_000_000);
    const first = t.check();
    t.release();
    await first;
    t.setClock(0); // set back by hours
    await t.check();
    expect(t.scheduled[0].ms).toBe(30_000);
  });
});

describe("createSessionCheck: guards", () => {
  it("skips a trailing check when the page holds no session by then", async () => {
    let clock = 0;
    let hasSession = true;
    const scheduled: Array<() => void> = [];
    const fake: SessionAuth = {
      getUser: vi.fn(async () => ({ error: null })),
      signOut: vi.fn(async () => ({})),
    };
    const check = createSessionCheck(fake, {
      now: () => clock,
      minIntervalMs: 30_000,
      schedule: (run) => scheduled.push(run),
      shouldRun: () => hasSession,
    });
    await check();
    clock = 10_000;
    await check();
    hasSession = false; // signed out meanwhile
    clock = 30_000;
    scheduled[0]();
    await Promise.resolve();
    expect(fake.getUser).toHaveBeenCalledTimes(1);
  });

  it("gives up on a check GoTrue does not answer, and runs the next one", async () => {
    vi.useFakeTimers();
    try {
      const fake: SessionAuth = {
        getUser: vi
          .fn()
          .mockImplementationOnce(() => new Promise(() => {}))
          .mockResolvedValue({ error: { code: "user_not_found" } }),
        signOut: vi.fn(async () => ({})),
      };
      let clock = 0;
      const check = createSessionCheck(fake, {
        now: () => clock,
        minIntervalMs: 30_000,
        timeoutMs: 10_000,
      });
      const hung = check();
      await vi.advanceTimersByTimeAsync(10_000);
      await hung;
      expect(fake.signOut).not.toHaveBeenCalled();
      clock = 30_000;
      await check();
      expect(fake.signOut).toHaveBeenCalledWith({ scope: "local" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadSession", () => {
  function steps(session: { id: string } | null, opts: { readFails?: boolean } = {}) {
    let settle: () => void = () => {};
    const order: string[] = [];
    return {
      order,
      settle: () => settle(),
      s: {
        getSession: vi.fn(async () => {
          if (opts.readFails) throw new Error("storage");
          return session;
        }),
        setSession: vi.fn((value: { id: string } | null) =>
          order.push(`set:${value?.id ?? "none"}`)
        ),
        check: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              order.push("check");
              settle = resolve;
            })
        ),
        markChecked: vi.fn(() => order.push("checked")),
      },
    };
  }

  it("marks a session checked only once its check settles", async () => {
    const t = steps({ id: "a" });
    const done = loadSession(t.s);
    await vi.waitFor(() => expect(t.s.check).toHaveBeenCalled());
    expect(t.s.markChecked).not.toHaveBeenCalled();
    t.settle();
    await done;
    expect(t.order).toEqual(["set:a", "check", "checked"]);
  });

  it("marks no session checked at once, without a check", async () => {
    const t = steps(null);
    await loadSession(t.s);
    expect(t.order).toEqual(["set:none", "checked"]);
    expect(t.s.check).not.toHaveBeenCalled();
  });

  it("settles the store and the flag when the read fails", async () => {
    const t = steps({ id: "a" }, { readFails: true });
    await loadSession(t.s);
    expect(t.order).toEqual(["set:none", "checked"]);
  });

  it("marks it checked when the check itself fails", async () => {
    const t = steps({ id: "a" });
    t.s.check.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    await loadSession(t.s);
    expect(t.order).toEqual(["set:a", "checked"]);
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
  function fakeWindow(answer: Response | (() => Promise<Response>)) {
    const original = vi.fn(function (this: unknown) {
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    });
    const win = { fetch: original, location: { origin: "https://webhooks.cc" } };
    return { win: win as unknown as Window, original };
  }

  it("calls the real fetch exactly as it was called, on the window", async () => {
    const { win, original } = fakeWindow(new Response(null, { status: 200 }));
    watchApiUnauthorized(win, () => {});
    const request = new Request("https://webhooks.cc/api/endpoints");
    await win.fetch(request);
    await win.fetch("/x");
    expect(original.mock.calls[0]).toEqual([request]);
    expect(original.mock.calls[1]).toEqual(["/x"]);
    expect(original.mock.contexts[0]).toBe(win);
  });

  it("hands a rejection back unchanged and reports nothing", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const { win } = fakeWindow(() => Promise.reject(abort));
    const seen = vi.fn();
    watchApiUnauthorized(win, seen);
    await expect(win.fetch("/api/endpoints")).rejects.toBe(abort);
    expect(seen).not.toHaveBeenCalled();
  });

  it("reports only a 401, from a Request as from a path", async () => {
    const answers = [403, 500, 200, 401];
    const { win } = fakeWindow(async () => new Response(null, { status: answers.shift()! }));
    const seen = vi.fn();
    watchApiUnauthorized(win, seen);
    for (let i = 0; i < 3; i++) await win.fetch("/api/endpoints");
    expect(seen).not.toHaveBeenCalled();
    await win.fetch(new Request("https://webhooks.cc/api/endpoints"));
    expect(seen).toHaveBeenCalledTimes(1);
  });

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

describe("startSessionChecks", () => {
  function setup(hasSession: boolean) {
    const fake: SessionAuth = {
      getUser: vi.fn(async () => ({ error: null })),
      signOut: vi.fn(async () => ({})),
    };
    const fetchFake = vi.fn(async () => new Response(null, { status: 401 }));
    const win = {
      fetch: fetchFake,
      location: { origin: "https://webhooks.cc" },
    } as unknown as Window;
    const check = startSessionChecks(fake, win, () => hasSession);
    return { fake, win, check };
  }

  it("checks on a 401 from our API while the page holds a session", async () => {
    const { fake, win } = setup(true);
    await win.fetch("/api/endpoints");
    await vi.waitFor(() => expect(fake.getUser).toHaveBeenCalledTimes(1));
  });

  it("does not check on a 401 with no session (a signed-out page)", async () => {
    const { fake, win } = setup(false);
    await win.fetch("/api/endpoints");
    await Promise.resolve();
    expect(fake.getUser).not.toHaveBeenCalled();
  });

  it("returns the check for the page load", async () => {
    const { fake, check } = setup(true);
    await check();
    expect(fake.getUser).toHaveBeenCalledTimes(1);
  });
});
