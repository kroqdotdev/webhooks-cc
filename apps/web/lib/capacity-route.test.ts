import { describe, expect, it, vi } from "vitest";

// The route helpers pull in the billing modules; parsing needs none of them.
vi.mock("@/lib/supabase/capacity-billing", () => ({}));
vi.mock("@/lib/supabase/team-billing", () => ({ TeamBillingError: class extends Error {} }));
vi.mock("@/lib/audit", () => ({ auditUserAction: vi.fn() }));

import { parseCapacityAction } from "./capacity-route";

describe("parseCapacityAction", () => {
  it("reads the three actions", () => {
    expect(parseCapacityAction({ action: "buy_blocks", blocks: 3 })).toEqual({
      resource: "requests",
      action: "buy_blocks",
      blocks: 3,
    });
    expect(parseCapacityAction({ action: "set_monthly_blocks", blocks: 0 })).toEqual({
      resource: "requests",
      action: "set_monthly_blocks",
      blocks: 0,
    });
    expect(parseCapacityAction({ action: "set_overage", enabled: true, maxBlocks: 5 })).toEqual({
      resource: "requests",
      action: "set_overage",
      enabled: true,
      maxBlocks: 5,
    });
    expect(parseCapacityAction({ action: "set_overage", enabled: false })).toEqual({
      resource: "requests",
      action: "set_overage",
      enabled: false,
    });
  });

  it("reads parsed-page actions, with their own block limit", () => {
    expect(parseCapacityAction({ resource: "pages", action: "buy_blocks", blocks: 900 })).toEqual({
      resource: "pages",
      action: "buy_blocks",
      blocks: 900,
    });
    expect(parseCapacityAction({ action: "buy_blocks", blocks: 900 })).toBeNull();
    expect(
      parseCapacityAction({ resource: "pages", action: "buy_blocks", blocks: 1001 })
    ).toBeNull();
    expect(
      parseCapacityAction({ resource: "minutes", action: "buy_blocks", blocks: 1 })
    ).toBeNull();
  });

  it("reads extra domains as recurring units only", () => {
    expect(
      parseCapacityAction({ resource: "domains", action: "set_monthly_blocks", blocks: 3 })
    ).toEqual({ resource: "domains", action: "set_monthly_blocks", blocks: 3 });
    expect(
      parseCapacityAction({ resource: "domains", action: "set_monthly_blocks", blocks: 20 })
    ).toBeNull();
    expect(
      parseCapacityAction({ resource: "domains", action: "buy_blocks", blocks: 1 })
    ).toBeNull();
    expect(
      parseCapacityAction({ resource: "domains", action: "set_overage", enabled: true })
    ).toBeNull();
  });

  it("refuses anything else", () => {
    expect(parseCapacityAction(null)).toBeNull();
    expect(parseCapacityAction({ action: "buy_blocks", blocks: 0 })).toBeNull();
    expect(parseCapacityAction({ action: "buy_blocks", blocks: 401 })).toBeNull();
    expect(parseCapacityAction({ action: "set_monthly_blocks", blocks: -1 })).toBeNull();
    expect(parseCapacityAction({ action: "set_overage", enabled: "yes" })).toBeNull();
    expect(parseCapacityAction({ action: "set_overage", enabled: true, maxBlocks: 0 })).toBeNull();
    expect(parseCapacityAction({ action: "refund_everything" })).toBeNull();
  });
});
