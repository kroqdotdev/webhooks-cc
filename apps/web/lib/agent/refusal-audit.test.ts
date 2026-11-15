import { beforeEach, describe, expect, test } from "vitest";
import { clearRefusalAuditGate, refusalAuditGate } from "./refusal-audit";

function from(ip: string): Request {
  return new Request("https://webhooks.cc/api/oauth2/token", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

beforeEach(() => clearRefusalAuditGate());

describe("refusalAuditGate", () => {
  test("lets one through a minute per address and code, and counts the rest", () => {
    const t = 1_000_000;
    expect(refusalAuditGate(from("192.0.2.1"), "invalid_issuer", t)).toEqual({
      record: true,
      suppressed: 0,
    });
    for (let i = 1; i <= 3; i++) {
      expect(refusalAuditGate(from("192.0.2.1"), "invalid_issuer", t + i)).toEqual({
        record: false,
      });
    }
    expect(refusalAuditGate(from("192.0.2.1"), "invalid_token", t).record).toBe(true);
    expect(refusalAuditGate(from("192.0.2.9"), "invalid_issuer", t).record).toBe(true);
    expect(refusalAuditGate(from("192.0.2.1"), "invalid_issuer", t + 60_000)).toEqual({
      record: true,
      suppressed: 3,
    });
  });

  test("counts an IPv6 client by its /64", () => {
    const t = 2_000_000;
    expect(refusalAuditGate(from("2001:db8:1:2::1"), "invalid_issuer", t).record).toBe(true);
    expect(refusalAuditGate(from("2001:db8:1:2::ffff"), "invalid_issuer", t).record).toBe(false);
  });
});
