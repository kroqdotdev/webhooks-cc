import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/polar", () => ({
  createPolarClient: vi.fn(),
  isEndedSubscriptionError: vi.fn(),
  loggablePolarError: vi.fn(),
}));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

import { duplicateVerdict, subscriptionStartMs } from "./billing-shared";

describe("subscriptionStartMs", () => {
  test("reads started_at, else created_at, else null", () => {
    expect(subscriptionStartMs({ started_at: "2026-08-01T00:00:00Z" })).toBe(
      Date.parse("2026-08-01T00:00:00Z")
    );
    expect(subscriptionStartMs({ started_at: null, created_at: "2026-08-02T00:00:00Z" })).toBe(
      Date.parse("2026-08-02T00:00:00Z")
    );
    expect(subscriptionStartMs({ started_at: "not a date" })).toBeNull();
    expect(subscriptionStartMs({})).toBeNull();
  });
});

describe("duplicateVerdict", () => {
  const at = (iso: string | null) => ({ started_at: iso });

  test("ends one that started after the stored one, however much later", () => {
    expect(duplicateVerdict(at("2026-08-01T00:00:01Z"), at("2026-08-01T00:00:00Z"))).toBe("end");
    expect(duplicateVerdict(at("2026-10-01T00:00:00Z"), at("2026-08-01T00:00:00Z"))).toBe("end");
  });

  test("ends one that started within two hours before the stored one", () => {
    // Twin checkouts whose events arrived out of order.
    expect(duplicateVerdict(at("2026-08-01T10:00:00Z"), at("2026-08-01T10:20:00Z"))).toBe("end");
    expect(duplicateVerdict(at("2026-08-01T08:00:00Z"), at("2026-08-01T10:00:00Z"))).toBe("end");
    expect(duplicateVerdict(at("2026-08-01T10:00:00Z"), at("2026-08-01T10:00:00Z"))).toBe("end");
  });

  test("reports one that started more than two hours before the stored one", () => {
    expect(duplicateVerdict(at("2026-08-01T07:59:59Z"), at("2026-08-01T10:00:00Z"))).toBe("report");
    expect(duplicateVerdict(at("2026-07-01T00:00:00Z"), at("2026-08-10T00:00:00Z"))).toBe("report");
  });

  test("reports when either start is missing", () => {
    expect(duplicateVerdict(at(null), at("2026-08-01T00:00:00Z"))).toBe("report");
    expect(duplicateVerdict(at("2026-08-01T00:00:00Z"), at(null))).toBe("report");
    expect(duplicateVerdict({}, {})).toBe("report");
  });
});
