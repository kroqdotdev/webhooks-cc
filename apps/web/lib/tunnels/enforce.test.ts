import { describe, expect, it } from "vitest";
import { ENTITLEMENTS, type PlanKey } from "@/lib/entitlements";
import { enforcement } from "./enforce";
import { foldEnded } from "./fold-ended";
import type { TunnelPlan } from "./plan";
import type { ShareRow } from "./shares";

function plan(key: PlanKey): TunnelPlan {
  return {
    key,
    label: key,
    limits: ENTITLEMENTS[key],
    notice: false,
    teamId: null,
    teamIds: [],
    activeTeamIds: [],
  };
}

const run = (id: string, startedMinute: number, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  user_id: "u1",
  name: null as string | null,
  free: false,
  notice: false,
  password_version: null as string | null,
  started_at: new Date(Date.UTC(2026, 10, 10, 12, startedMinute)).toISOString(),
  expires_at: null as string | null,
  ...extra,
});

const freeRun = (id: string, startedMinute: number) =>
  run(id, startedMinute, { free: true, notice: true, expires_at: "2026-11-10T14:00:00.000Z" });

describe("enforcement", () => {
  it("ends the newest previews beyond the plan's number", () => {
    const result = enforcement(
      [freeRun("old", 0), freeRun("mid", 5), freeRun("new", 10)],
      new Map([["u1", { ...plan("free"), notice: true }]]),
      []
    );
    expect(result.end.sort()).toEqual(["mid", "new"]);
  });

  it("ends paid previews when the plan is now Free, or now asks for the notice or a time limit", () => {
    const free = { ...plan("free"), notice: true };
    // Opened on Pro: no -free name, no notice, no time limit.
    expect(enforcement([run("paid", 0)], new Map([["u1", free]]), []).end).toEqual(["paid"]);
    // Opened on Pro within its first days (notice on), then Free.
    expect(
      enforcement([run("fresh", 0, { notice: true })], new Map([["u1", free]]), []).end
    ).toEqual(["fresh"]);
    // Staff restored the notice on a paid account: runs without it end.
    const proWithNotice = { ...plan("pro"), notice: true };
    expect(enforcement([run("p", 0)], new Map([["u1", proWithNotice]]), []).end).toEqual(["p"]);
    // The notice turning off (the 7 days passed) ends nothing.
    expect(
      enforcement([run("q", 0, { notice: true })], new Map([["u1", plan("pro")]]), []).end
    ).toEqual([]);
    // A Free preview stays.
    expect(enforcement([freeRun("f", 0)], new Map([["u1", free]]), []).end).toEqual([]);
  });

  it("ends run passwords the plan lacks and own names past its count, oldest names covered", () => {
    const names = [
      { name: "first", user_id: "u1", team_id: null, created_at: "2026-11-01T00:00:00Z" },
      { name: "second", user_id: "u1", team_id: null, created_at: "2026-11-02T00:00:00Z" },
      { name: "third", user_id: "u1", team_id: null, created_at: "2026-11-03T00:00:00Z" },
      { name: "fourth", user_id: "u1", team_id: null, created_at: "2026-11-04T00:00:00Z" },
    ];
    const pro = enforcement(
      [run("a", 0, { name: "first" }), run("b", 1, { name: "fourth" })],
      new Map([["u1", plan("pro")]]),
      names
    );
    expect(pro.end).toEqual(["b"]);

    const business = enforcement(
      [run("p", 0, { password_version: "v1" })],
      new Map([["u1", plan("business")]]),
      []
    );
    expect(business.end).toEqual([]);
    const free = enforcement(
      [{ ...freeRun("p", 0), password_version: "v1" }],
      new Map([["u1", { ...plan("free"), notice: true }]]),
      []
    );
    expect(free.end).toEqual(["p"]);
  });

  it("counts team names against the team, never against the keeper's own names", () => {
    // The owner keeps 3 own names (Pro covers 3) and, handed over from a
    // member who left, an older team name: their own previews keep running.
    const names = [
      { name: "team-old", user_id: "u1", team_id: "t1", created_at: "2026-01-01T00:00:00Z" },
      { name: "own-a", user_id: "u1", team_id: null, created_at: "2026-02-01T00:00:00Z" },
      { name: "own-b", user_id: "u1", team_id: null, created_at: "2026-03-01T00:00:00Z" },
      { name: "own-c", user_id: "u1", team_id: null, created_at: "2026-04-01T00:00:00Z" },
    ];
    const result = enforcement(
      [run("r1", 0, { name: "own-c" }), run("r2", 1, { name: "team-old" })],
      new Map([["u1", plan("team")]]),
      names,
      new Map([["t1", 6]])
    );
    expect(result.end).toEqual([]);
  });

  it("ends previews under team names past the team's cap, the newest names waiting", () => {
    const names = [
      { name: "t-a", user_id: "u2", team_id: "t1", created_at: "2026-01-01T00:00:00Z" },
      { name: "t-b", user_id: "u1", team_id: "t1", created_at: "2026-01-02T00:00:00Z" },
      { name: "t-c", user_id: "u1", team_id: "t1", created_at: "2026-01-03T00:00:00Z" },
    ];
    const result = enforcement(
      [run("r1", 0, { name: "t-b" }), run("r2", 1, { name: "t-c" })],
      new Map([["u1", plan("team")]]),
      names,
      new Map([["t1", 2]])
    );
    expect(result.end).toEqual(["r2"]);
  });

  it("leaves accounts it has no plan for alone", () => {
    expect(enforcement([run("x", 0)], new Map(), [])).toEqual({ end: [] });
  });
});

describe("foldEnded", () => {
  const row = (id: string, instance: string | null, start: number, end: number, reason: string) =>
    ({
      id,
      kind: "share",
      user_id: "u1",
      name: "calm-river-0042",
      endpoint_id: null,
      free: false,
      notice: false,
      client: "",
      key_id: null,
      instance,
      client_address: null,
      started_at: new Date(Date.UTC(2026, 10, 10, 12, start)).toISOString(),
      expires_at: null,
      ended_at: new Date(Date.UTC(2026, 10, 10, 12, end)).toISOString(),
      end_reason: reason,
      password_hash: null,
      password_version: null,
      bytes: 10,
      requests: 1,
    }) as ShareRow;

  it("folds a run's reconnects into one, with its last ending and summed counts", () => {
    const folded = foldEnded(
      [row("r1", "run-a", 0, 10, "edge restart"), row("r2", "run-a", 11, 20, "stopped")],
      new Set(),
      30
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ id: "r2", end_reason: "stopped", bytes: 20, requests: 2 });
    expect(folded[0].started_at).toBe("2026-11-10T12:00:00.000Z");
  });

  it("leaves out runs that reconnected and are live again", () => {
    expect(
      foldEnded([row("r1", "run-b", 0, 10, "edge restart")], new Set(["u1:run-b"]), 30)
    ).toEqual([]);
  });
});
