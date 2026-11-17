import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSmtpTarget, runLeg, type CanaryLeg } from "./canary";

function leg(overrides: Partial<CanaryLeg> = {}): CanaryLeg {
  return {
    label: "test",
    heartbeatUrl: "https://statoss.test/api/heartbeat/t",
    send: vi.fn().mockResolvedValue(undefined),
    find: vi.fn().mockResolvedValue("request-1"),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const fast = { findForMs: 50, findEveryMs: 5, nonce: "abc123" };

describe("runLeg", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pings once the canary is found, after removing it", async () => {
    const ping = vi.fn().mockResolvedValue(true);
    const l = leg();
    expect(await runLeg(l, { ...fast, ping })).toBe("ok");
    expect(l.send).toHaveBeenCalledWith("abc123");
    expect(l.find).toHaveBeenCalledWith("abc123", expect.any(Date));
    expect(l.remove).toHaveBeenCalledWith("request-1");
    expect(ping).toHaveBeenCalledWith("https://statoss.test/api/heartbeat/t", "test canary");
  });

  it("keeps looking until the capture shows up", async () => {
    const ping = vi.fn().mockResolvedValue(true);
    const find = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("request-2");
    expect(await runLeg(leg({ find }), { ...fast, ping })).toBe("ok");
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("does not ping when the send fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ping = vi.fn();
    const l = leg({ send: vi.fn().mockRejectedValue(new Error("connection refused")) });
    expect(await runLeg(l, { ...fast, ping })).toBe("send_failed");
    expect(l.find).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it("does not ping when nothing was captured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ping = vi.fn();
    const l = leg({ find: vi.fn().mockResolvedValue(null) });
    expect(await runLeg(l, { ...fast, ping })).toBe("not_captured");
    expect(l.remove).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it("tells a lookup that keeps failing from a missing capture", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ping = vi.fn();
    const l = leg({ find: vi.fn().mockRejectedValue(new Error("db down")) });
    expect(await runLeg(l, { ...fast, ping })).toBe("lookup_failed");
    expect(ping).not.toHaveBeenCalled();
  });

  it("still pings when only the removal fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ping = vi.fn().mockResolvedValue(true);
    const l = leg({ remove: vi.fn().mockRejectedValue(new Error("nope")) });
    expect(await runLeg(l, { ...fast, ping })).toBe("ok");
    expect(ping).toHaveBeenCalledTimes(1);
  });
});

describe("parseSmtpTarget", () => {
  it("reads a host with or without a port", () => {
    expect(parseSmtpTarget("10.20.0.3:25")).toEqual({ host: "10.20.0.3", port: 25 });
    expect(parseSmtpTarget("mx.mailhooks.cc")).toEqual({ host: "mx.mailhooks.cc", port: 25 });
    expect(parseSmtpTarget("localhost:2525")).toEqual({ host: "localhost", port: 2525 });
    expect(parseSmtpTarget("[::1]:25")).toEqual({ host: "::1", port: 25 });
  });

  it("refuses what is not host:port", () => {
    expect(parseSmtpTarget("")).toBeNull();
    expect(parseSmtpTarget("smtp://host")).toBeNull();
    expect(parseSmtpTarget("host:0")).toBeNull();
    expect(parseSmtpTarget("host:70000")).toBeNull();
  });
});
