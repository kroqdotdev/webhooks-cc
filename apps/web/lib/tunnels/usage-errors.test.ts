import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

const { isTransientDbError, recordUsage } = await import("./usage");

const ID = "6f1c2a4e-1b2c-4d3e-8f90-1a2b3c4d5e6f";
const batch = (id: string) => ({ id, usage: [{ id: ID, kind: "share", bytes: 1, requests: 1 }] });

describe("tunnel usage batch errors", () => {
  beforeEach(() => rpc.mockReset());

  it("tells passing database errors from lasting ones", () => {
    for (const code of ["08006", "40001", "40P01", "53300", "57014", "57P01", "55P03", "PGRST001"])
      expect(isTransientDbError({ code, message: "x" })).toBe(true);
    expect(isTransientDbError(new TypeError("fetch failed"))).toBe(true);
    for (const code of ["23502", "22P02", "42883", "PGRST202"])
      expect(isTransientDbError({ code, message: "x" })).toBe(false);
  });

  it("throws on a passing error, so the edge sends every batch again", async () => {
    rpc.mockResolvedValueOnce({ error: null });
    rpc.mockResolvedValueOnce({ error: { code: "40P01", message: "deadlock detected" } });
    await expect(recordUsage([batch("b1"), batch("b2"), batch("b3")])).rejects.toMatchObject({
      code: "40P01",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("drops a batch the database refuses for good and adds the rest", async () => {
    rpc.mockResolvedValueOnce({ error: { code: "23502", message: "null value" } });
    rpc.mockResolvedValueOnce({ error: null });
    await expect(recordUsage([batch("b1"), batch("b2")])).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
