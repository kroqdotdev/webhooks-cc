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
  password_version: null as string | null,
  started_at: new Date(Date.UTC(2026, 10, 10, 12, startedMinute)).toISOString(),
  expires_at: null as string | null,
  ...extra,
});

describe("enforcement", () => {
  it("ends the newest previews beyond the plan's number and gives the rest its time limit", () => {
    const result = enforcement(
      [run("old", 0), run("mid", 5), run("new", 10)],
      new Map([["u1", plan("free")]]),
      []
    );
    expect(result.end.sort()).toEqual(["mid", "new"]);
    expect(result.expire).toEqual([{ id: "old", at: "2026-11-10T14:00:00.000Z" }]);
  });

  it("ends run passwords the plan lacks and names past its count, oldest names covered", () => {
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
    expect(pro.expire).toEqual([]);

    const free = enforcement(
      [run("p", 0, { password_version: "v1" })],
      new Map([["u1", plan("free")]]),
      []
    );
    expect(free.end).toEqual(["p"]);
  });

  it("leaves accounts it has no plan for alone", () => {
    expect(enforcement([run("x", 0)], new Map(), [])).toEqual({ end: [], expire: [] });
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
