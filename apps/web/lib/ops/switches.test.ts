import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the next database call answers, in order: a read of the switch
 * (maybeSingle) or a write that selects what it wrote (awaited as is).
 */
type Answer = { data: unknown; error: { message: string } | null };
let answers: (Answer | Promise<Answer>)[] = [];
let calls: string[] = [];

function next(): Answer | Promise<Answer> {
  return answers.shift() ?? { data: { off: false }, error: null };
}

function query(table: string) {
  calls.push(`from:${table}`);
  const chain = {
    select: (columns?: string) => (calls.push(`select:${columns ?? ""}`), chain),
    eq: (column: string, value: unknown) => (calls.push(`eq:${column}=${value}`), chain),
    update: (row: Record<string, unknown>) => (calls.push(`update:off=${row.off}`), chain),
    upsert: (row: Record<string, unknown>) => (calls.push(`upsert:off=${row.off}`), chain),
    maybeSingle: async () => next(),
    then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject),
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: query }) }));
const reportError = vi.fn();
vi.mock("@/lib/observability", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

const { freshSwitchState, resetSwitchCache, setSwitch, switchedOff } = await import("./switches");

const reads = () => calls.filter((call) => call === "select:off").length;
const row = (off: boolean, reason = "why") => ({
  name: "ai_assists",
  off,
  reason,
  changed_by: "staff-1",
  changed_at: "2026-11-22T12:00:00.000Z",
});

beforeEach(() => {
  resetSwitchCache();
  answers = [];
  calls = [];
  reportError.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("switchedOff", () => {
  it("trusts what it read for 10 seconds, then reads again", async () => {
    answers = [
      { data: { off: true }, error: null },
      { data: { off: false }, error: null },
    ];
    expect(await switchedOff("ai_assists")).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(1);
    vi.advanceTimersByTime(2);
    expect(await switchedOff("ai_assists")).toBe(false);
    expect(reads()).toBe(2);
  });

  it("reads again at once when asked for a fresh answer", async () => {
    answers = [
      { data: { off: false }, error: null },
      { data: { off: true }, error: null },
    ];
    expect(await switchedOff("ai_assists")).toBe(false);
    expect(await freshSwitchState("ai_assists")).toBe("off");
    // The fresh answer is what the cache holds from then on.
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(2);
  });

  it("counts a missing row as on", async () => {
    answers = [{ data: null, error: null }];
    expect(await switchedOff("ai_assists")).toBe(false);
  });

  it("keeps the last answer when a read fails, reports it, and caches the failure", async () => {
    answers = [
      { data: { off: true }, error: null },
      { data: null, error: { message: "relation does not exist" } },
    ];
    expect(await switchedOff("ai_assists")).toBe(true);
    vi.advanceTimersByTime(10_001);
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    // Not read again on every request while the database is sick.
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(2);
  });

  it("counts a failed first read as on", async () => {
    answers = [{ data: null, error: { message: "down" } }];
    expect(await switchedOff("ai_assists")).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("answers unknown for a fresh read that failed", async () => {
    answers = [
      { data: null, error: { message: "down" } },
      { data: null, error: { message: "still down" } },
    ];
    expect(await freshSwitchState("ai_assists")).toBe("unknown");
    expect(reads()).toBe(2);
  });

  it("reads once more after a failed fresh read", async () => {
    answers = [
      { data: null, error: { message: "blip" } },
      { data: { off: false }, error: null },
    ];
    expect(await freshSwitchState("ai_assists")).toBe("on");
  });

  it("does not let a read that started before a change put the old state back", async () => {
    let release: (answer: Answer) => void = () => undefined;
    answers = [new Promise<Answer>((resolve) => (release = resolve))];
    // A read starts and waits on the database...
    const reading = switchedOff("ai_assists");
    // ...while this process turns the switch off.
    answers.push({ data: [row(true)], error: null });
    await setSwitch("ai_assists", true, "why", "staff-1");
    // The read answers with the state from before the change.
    release({ data: { off: false }, error: null });
    expect(await reading).toBe(false);
    // The cache keeps what the change wrote.
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(1);
  });

  it("does not cache a read that ran before a change committed and answered after it", async () => {
    let release: (answer: Answer) => void = () => undefined;
    let landWrite: (answer: Answer) => void = () => undefined;
    // The change's update waits, then the read starts and waits too.
    answers = [new Promise<Answer>((resolve) => (landWrite = resolve))];
    const changing = setSwitch("ai_assists", true, "why", "staff-1");
    // The update has taken its answer from the queue.
    await vi.waitFor(() => expect(answers).toHaveLength(0));
    answers.push(new Promise<Answer>((resolve) => (release = resolve)));
    const reading = switchedOff("ai_assists");
    landWrite({ data: [row(true)], error: null });
    await changing;
    // The read saw the row before the update committed.
    release({ data: { off: false }, error: null });
    expect(await reading).toBe(false);
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(1);
  });
});

describe("setSwitch", () => {
  it("writes a change and answers from the row it wrote, with no read after it", async () => {
    answers = [{ data: [row(true, "model misbehaving")], error: null }];
    const saved = await setSwitch("ai_assists", true, "model misbehaving", "staff-1");
    expect(saved).toEqual({
      changed: true,
      switch: {
        name: "ai_assists",
        off: true,
        reason: "model misbehaving",
        changedBy: "staff-1",
        changedAt: "2026-11-22T12:00:00.000Z",
      },
    });
    expect(calls).toContain("update:off=true");
    expect(calls).toContain("eq:off=false");
    expect(calls).not.toContain("upsert:off=true");
    expect(answers).toHaveLength(0);
    // This process sees it at once.
    expect(await switchedOff("ai_assists")).toBe(true);
    expect(reads()).toBe(0);
  });

  it("changes nothing when it already has that state, and answers what the row says", async () => {
    answers = [
      { data: [], error: null },
      // The insert finds the row there and does nothing.
      { data: [], error: null },
      { data: row(true, "earlier reason"), error: null },
    ];
    const saved = await setSwitch("ai_assists", true, "from another tab", "staff-2");
    expect(saved.changed).toBe(false);
    expect(saved.switch).toMatchObject({ off: true, reason: "earlier reason" });
  });

  it("adds the row when there is none and it is turned off", async () => {
    answers = [
      { data: [], error: null },
      { data: [row(true)], error: null },
    ];
    const saved = await setSwitch("ai_assists", true, "why", "staff-1");
    expect(saved).toMatchObject({ changed: true, switch: { off: true } });
    expect(calls).toContain("upsert:off=true");
  });

  it("writes nothing to turn on a switch that has no row, since it reads as on", async () => {
    answers = [
      { data: [], error: null },
      { data: null, error: null },
    ];
    const saved = await setSwitch("ai_assists", false, "why", "staff-1");
    expect(saved).toMatchObject({ changed: false, switch: { off: false, reason: null } });
    expect(calls.some((call) => call.startsWith("upsert"))).toBe(false);
  });

  it("throws when the write fails, and keeps the cache", async () => {
    answers = [
      { data: { off: false }, error: null },
      { data: null, error: { message: "down" } },
    ];
    expect(await switchedOff("ai_assists")).toBe(false);
    await expect(setSwitch("ai_assists", true, "why", "staff-1")).rejects.toMatchObject({
      message: "down",
    });
    expect(await switchedOff("ai_assists")).toBe(false);
  });
});
