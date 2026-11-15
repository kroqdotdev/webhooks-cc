import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** Rows answered after the first read (the poll's re-read), in order. */
  later: [] as Array<Record<string, unknown> | null>,
  unrecorded: undefined as
    | {
        running(run: unknown): Promise<boolean>;
        result(params: unknown): Record<string, unknown>;
      }
    | undefined,
}));

vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    let reads = 0;
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => {
        reads += 1;
        const data = reads > 1 && mocks.later.length > 0 ? mocks.later.shift()! : mocks.row;
        return { data, error: null };
      },
    };
    return { from: () => query };
  },
}));

vi.mock("./actions", () => ({
  ActionError: class ActionError extends Error {},
  actionSpec: () => ({ runAt: "approve", unrecorded: mocks.unrecorded }),
}));

const { pollApproval, requesterLabelFor } = await import("./store");

describe("who asked", () => {
  test("an agent's name is the one it gave itself, cleaned", () => {
    expect(
      requesterLabelFor({
        kind: "agent",
        clientName: 'Claude" (verified by webhooks.cc)\u202E\u200B\u0301',
      })
    ).toBe('a connected agent that calls itself "Claude (verified by webhooks.cc)"');
    expect(requesterLabelFor({ kind: "agent", clientName: '"\u200B"' })).toBe("a connected agent");
    expect(requesterLabelFor({ kind: "agent", clientName: null })).toBe("a connected agent");
  });

  test("a long name is cut by code point without splitting a surrogate pair", () => {
    const label = requesterLabelFor({ kind: "agent", clientName: "\u{1F600}".repeat(100) });
    const name = label.slice(label.indexOf('"') + 1, label.lastIndexOf('"'));
    expect(Array.from(name)).toHaveLength(64);
    expect(name).toBe("\u{1F600}".repeat(64));
  });

  test("an API key is named by its cleaned name and prefix", () => {
    expect(
      requesterLabelFor({ kind: "key", name: 'deploy"\n bot', keyPrefix: "whcc_abc1234" })
    ).toBe('the API key "deploy bot" (whcc_abc1234...)');
    expect(requesterLabelFor({ kind: "unknown" })).toBe("an API key");
  });
});

describe("an approval that ran and left no result", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const row = (completedAgoMs: number) => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    user_id: "owner",
    action: "billing.change",
    params: {},
    summary: "Change the team from 3 to 5 seats.",
    user_code: "ABCD-EFGH",
    status: "completed",
    requested_by_key: "key-1",
    requested_by_agent: null,
    requester: "an API key",
    client: null,
    country: null,
    network: null,
    created_at: new Date(now - completedAgoMs - 60_000).toISOString(),
    completed_at: new Date(now - completedAgoMs).toISOString(),
    expires_at: new Date(now - completedAgoMs + 15 * 60_000).toISOString(),
    result: null,
  });
  const asker = { userId: "owner", keyId: "key-1" };
  const unknown = { executed: null, code: "outcome_unknown", reason: "Check billing." };

  const running = vi.fn<(run: unknown) => Promise<boolean>>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.later = [];
    running.mockReset();
    mocks.unrecorded = { running, result: () => unknown };
  });

  test("still reads as running while the action says its run is going, however long", async () => {
    // A slow run past what a run usually takes, still holding its lease.
    mocks.row = row(10 * 60_000);
    running.mockResolvedValue(true);
    const polled = await pollApproval(String(mocks.row.id), asker);
    expect(polled?.approval.status).toBe("approved");
    expect(polled?.result).toBeUndefined();
    expect(running).toHaveBeenCalledWith({
      approvalId: mocks.row.id,
      userId: "owner",
      params: {},
      startedAtMs: now - 10 * 60_000,
    });
  });

  test("answers the action's unknown outcome once its run is over without a result", async () => {
    mocks.row = row(60_000);
    running.mockResolvedValue(false);
    const polled = await pollApproval(String(mocks.row.id), asker);
    expect(polled?.approval.status).toBe("completed");
    expect(polled?.result).toEqual(unknown);
  });

  test("reads a result the run recorded just before it ended, never the unknown one", async () => {
    mocks.row = row(60_000);
    const made = { executed: true, applied: "now" };
    mocks.later = [{ result: made }];
    running.mockResolvedValue(false);
    const polled = await pollApproval(String(mocks.row.id), asker);
    expect(polled?.result).toEqual(made);
  });

  test("an action without one keeps the asker waiting until the row expires", async () => {
    mocks.unrecorded = undefined;
    mocks.row = row(6 * 60_000);
    expect((await pollApproval(String(mocks.row.id), asker))?.approval.status).toBe("approved");
    mocks.row = row(16 * 60_000);
    expect((await pollApproval(String(mocks.row.id), asker))?.approval.status).toBe("expired");
  });
});

describe("a refused budget raise", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const row = (result: unknown) => ({
    id: "00000000-0000-4000-8000-0000000000bb",
    user_id: "owner",
    action: "billing.agent_budget",
    params: {},
    summary: "Set the agent budget of your account to $100.00 per 30 days.",
    user_code: "ABCD-EFGH",
    status: "denied",
    requested_by_key: "key-1",
    requested_by_agent: null,
    requester: "an API key",
    client: null,
    country: null,
    network: null,
    created_at: new Date(now - 60_000).toISOString(),
    completed_at: null,
    expires_at: new Date(now + 14 * 60_000).toISOString(),
    result,
  });
  const asker = { userId: "owner", keyId: "key-1" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.later = [];
    mocks.unrecorded = undefined;
  });

  test("says the budget changed, so the agent reads it again and asks again", async () => {
    mocks.row = row({ code: "budget_changed" });
    const polled = await pollApproval(String(mocks.row.id), asker);
    expect(polled?.approval.status).toBe("denied");
    expect(polled?.result).toEqual({ code: "budget_changed" });
  });

  test("a refusal by the owner carries no result", async () => {
    mocks.row = row(null);
    const polled = await pollApproval(String(mocks.row.id), asker);
    expect(polled?.approval.status).toBe("denied");
    expect(polled?.result).toBeUndefined();
  });
});
