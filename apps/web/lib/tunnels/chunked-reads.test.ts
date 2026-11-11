import { beforeEach, describe, expect, it, vi } from "vitest";
import { IN_CHUNK } from "@/lib/supabase/in-chunks";

/*
 * The edge's sync reads lists that grow with every run it holds: a fake
 * client records each `.in()` filter, so no query here ever carries more
 * than IN_CHUNK values (PostgREST takes them in the URL; about 420 uuids
 * already break it).
 */

const RUNS = 1_000;
const inSizes: number[] = [];

const runs = Array.from({ length: RUNS }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  user_id: `user-${i}`,
  name: `name-${i}`,
  free: false,
  notice: false,
  password_version: null,
  password_hash: null,
  started_at: "2026-11-10T12:00:00.000Z",
  expires_at: null,
}));

function rowsFor(table: string, filters: Map<string, string[]>): unknown[] {
  const only = (col: string) => filters.get(col);
  if (table === "tunnel_shares") {
    const ids = only("id");
    return ids ? runs.filter((r) => ids.includes(r.id)) : runs;
  }
  if (table === "users")
    return (only("id") ?? []).map((id) => ({
      id,
      plan: "business",
      paid_since: null,
      tunnel_notice_lifted: false,
    }));
  if (table === "tunnel_names") {
    // Every run's name is a team's name with a password another member kept.
    const names = only("name") ?? [];
    return names.map((name, i) => ({
      name,
      user_id: `keeper-${i}`,
      team_id: `team-${name}`,
      password_version: "v1",
      created_at: "2026-11-01T00:00:00.000Z",
    }));
  }
  return [];
}

function query(table: string) {
  const filters = new Map<string, string[]>();
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "lt", "gt", "limit", "order", "update"])
    builder[m] = () => builder;
  builder.in = (col: string, values: string[]) => {
    inSizes.push(values.length);
    filters.set(col, values);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: rowsFor(table, filters), error: null });
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => query(table),
    rpc: async () => ({ data: [], error: null }),
  }),
}));

beforeEach(() => {
  inSizes.length = 0;
});

describe("reads over edge-sized lists", () => {
  it("holds 1,000 open runs to their plans in chunks", async () => {
    const { enforcePlans } = await import("./enforce");
    await enforcePlans();
    expect(inSizes.length).toBeGreaterThan(0);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(IN_CHUNK);
    // users, memberships and own names: each over all 1,000 accounts.
    expect(inSizes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3 * RUNS);
  });

  it("reads the password versions of 1,000 previews in chunks", async () => {
    const { gateVersions } = await import("./passwords");
    const gates = await gateVersions(runs.map((r) => r.id));
    expect(gates).toHaveLength(RUNS);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(IN_CHUNK);
  });

  it("reads the plans of 1,000 accounts in chunks", async () => {
    const { tunnelPlansOf } = await import("./plan");
    const plans = await tunnelPlansOf(runs.map((r) => r.user_id));
    expect(plans.size).toBe(RUNS);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(IN_CHUNK);
  });
});
