import { beforeEach, describe, expect, it, vi } from "vitest";

// A request read by id carries its endpoint's slug, which the lookup reads
// for its access check anyway, so a client needs no endpoint list to name it.

const rows: Record<string, unknown> = {};

/** A PostgREST query on one table that answers its row whatever the filters. */
function table(name: string) {
  const query = {
    select: () => query,
    eq: () => query,
    gt: () => query,
    returns: () => query,
    maybeSingle: async () => ({ data: rows[name] ?? null, error: null }),
  };
  return query;
}

vi.mock("./admin", () => ({
  createAdminClient: () => ({ from: table }),
}));

const resolveEndpointAccess = vi.fn();
vi.mock("./teams", () => ({ resolveEndpointAccess }));

const { getRequestByIdForUser, getSandboxRequest } = await import("./requests");

const REQUEST_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  endpoint_id: "ep_1",
  method: "POST",
  path: "/orders",
  headers: { "content-type": "application/json" },
  body: "{}",
  body_raw: null,
  query_params: {},
  content_type: "application/json",
  ip: "192.0.2.1",
  size: 2,
  received_at: new Date().toISOString(),
  team_id: null,
  kind: "http",
  email: null,
};

beforeEach(() => {
  for (const key of Object.keys(rows)) delete rows[key];
  resolveEndpointAccess.mockReset();
  rows.requests = REQUEST_ROW;
  rows.users = { plan: "pro", retention_floor_days: null, retention_floor_until: null };
});

describe("a request read by id", () => {
  it("names its endpoint's slug", async () => {
    rows.endpoints = { slug: "acme-orders", user_id: "user_1" };
    resolveEndpointAccess.mockResolvedValue({
      endpointId: "ep_1",
      ownerId: "user_1",
      retentionDays: null,
    });
    const request = await getRequestByIdForUser("user_1", REQUEST_ROW.id);
    expect(request).toMatchObject({ id: REQUEST_ROW.id, endpointSlug: "acme-orders" });
    expect(resolveEndpointAccess).toHaveBeenCalledWith("user_1", "acme-orders");
  });

  it("is still refused without access", async () => {
    rows.endpoints = { slug: "acme-orders", user_id: "user_2" };
    resolveEndpointAccess.mockResolvedValue(null);
    expect(await getRequestByIdForUser("user_1", REQUEST_ROW.id)).toBeNull();
  });

  it("names the slug of a sandbox endpoint too", async () => {
    rows.endpoints = { id: "ep_1", slug: "sandbox-acme" };
    const request = await getSandboxRequest("reg_1", REQUEST_ROW.id);
    expect(request).toMatchObject({ id: REQUEST_ROW.id, endpointSlug: "sandbox-acme" });
  });
});
