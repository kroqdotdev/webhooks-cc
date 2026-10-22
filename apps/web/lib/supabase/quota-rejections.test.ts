import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("./admin", () => ({
  createAdminClient: () => ({ rpc }),
}));

const { getQuotaRejections, NO_QUOTA_REJECTIONS, QUOTA_REJECTION_ENDPOINT_LIMIT } =
  await import("./quota-rejections");

describe("getQuotaRejections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for the default number of endpoints", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await getQuotaRejections("u1");
    expect(rpc).toHaveBeenCalledWith("get_quota_rejections", {
      p_user_id: "u1",
      p_limit: QUOTA_REJECTION_ENDPOINT_LIMIT,
    });
  });

  it("returns the empty summary when there are no rejections", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(getQuotaRejections("u1")).resolves.toBe(NO_QUOTA_REJECTIONS);
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getQuotaRejections("u1")).resolves.toBe(NO_QUOTA_REJECTIONS);
  });

  it("maps rows into a total and per-endpoint counts", async () => {
    rpc.mockResolvedValue({
      data: [
        { slug: "a", quota_rejected: "30", total_rejected: "42", endpoint_count: "3" },
        { slug: "b", quota_rejected: 10, total_rejected: 42, endpoint_count: 3 },
      ],
      error: null,
    });
    await expect(getQuotaRejections("u1", 2)).resolves.toEqual({
      total: 42,
      endpointCount: 3,
      endpoints: [
        { slug: "a", rejected: 30 },
        { slug: "b", rejected: 10 },
      ],
    });
  });

  it("throws when the query fails", async () => {
    const error = { message: "boom" };
    rpc.mockResolvedValue({ data: null, error });
    await expect(getQuotaRejections("u1")).rejects.toBe(error);
  });
});
