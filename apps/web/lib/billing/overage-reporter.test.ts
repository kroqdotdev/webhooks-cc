import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  rpc: vi.fn(),
  ingest: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mockFns.rpc }),
}));
vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({ events: { ingest: mockFns.ingest } }),
  getCapacityProductIds: () => null,
  loggablePolarError: (error: unknown) => error,
}));
vi.mock("@/lib/observability", () => ({ reportError: mockFns.reportError }));

import { overageEvent, reportOverage, type OverageReport } from "./overage-reporter";

const alice: OverageReport = {
  account_kind: "user",
  account_id: "user_a",
  polar_customer_id: "cus_a",
  from_total: 10,
  to_total: 25,
};
const acme: OverageReport = {
  account_kind: "team",
  account_id: "team_b",
  polar_customer_id: "cus_b",
  from_total: 0,
  to_total: 4,
};

function claims(rows: OverageReport[]) {
  mockFns.rpc.mockImplementation(async (name: string) =>
    name === "claim_overage_reports" ? { data: rows, error: null } : { data: null, error: null }
  );
}

describe("overageEvent", () => {
  it("names the range it covers, so a resend is the same event", () => {
    expect(overageEvent(alice)).toEqual({
      name: "request.overage",
      customer_id: "cus_a",
      external_id: "overage:user:user_a:10-25",
      metadata: { requests: 15 },
    });
  });
});

describe("reportOverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFns.ingest.mockResolvedValue({ inserted: 1, duplicates: 0 });
  });

  it("sends every claimed range in one batch and confirms each", async () => {
    claims([alice, acme]);
    await expect(reportOverage()).resolves.toEqual({ sent: 2, failed: 0 });
    expect(mockFns.ingest).toHaveBeenCalledTimes(1);
    expect(mockFns.ingest.mock.calls[0][0].events).toHaveLength(2);
    expect(mockFns.rpc).toHaveBeenCalledWith("complete_overage_report", {
      p_account_kind: "team",
      p_account_id: "team_b",
      p_to_total: 4,
    });
  });

  it("falls back to one event at a time, so one bad customer cannot hold up the rest", async () => {
    claims([alice, acme]);
    mockFns.ingest
      .mockRejectedValueOnce(new Error("batch refused"))
      .mockRejectedValueOnce(new Error("unknown customer"))
      .mockResolvedValueOnce({ inserted: 1, duplicates: 0 });

    await expect(reportOverage()).resolves.toEqual({ sent: 1, failed: 1 });
    const completed = mockFns.rpc.mock.calls.filter(([name]) => name === "complete_overage_report");
    expect(completed).toEqual([
      [
        "complete_overage_report",
        { p_account_kind: "team", p_account_id: "team_b", p_to_total: 4 },
      ],
    ]);
  });

  it("sets aside a range Polar refuses for good, so it is not retried forever", async () => {
    claims([alice]);
    mockFns.ingest
      .mockRejectedValueOnce(Object.assign(new Error("unprocessable"), { statusCode: 422 }))
      .mockRejectedValueOnce(Object.assign(new Error("unprocessable"), { statusCode: 422 }));

    await expect(reportOverage()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(mockFns.rpc).toHaveBeenCalledWith("complete_overage_report", {
      p_account_kind: "user",
      p_account_id: "user_a",
      p_to_total: 25,
    });
    expect(mockFns.reportError).toHaveBeenCalled();
  });

  it.each([401, 403])("keeps a range for a retry when Polar answers %i", async (statusCode) => {
    claims([alice]);
    mockFns.ingest
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { statusCode }))
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { statusCode }));

    await expect(reportOverage()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(mockFns.rpc).not.toHaveBeenCalledWith("complete_overage_report", expect.anything());
  });

  it("retries a range after a transient failure", async () => {
    claims([alice]);
    mockFns.ingest
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }));

    await expect(reportOverage()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(mockFns.rpc).not.toHaveBeenCalledWith("complete_overage_report", expect.anything());
  });

  it("does nothing without claimed overage", async () => {
    claims([]);
    await expect(reportOverage()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(mockFns.ingest).not.toHaveBeenCalled();
  });
});
