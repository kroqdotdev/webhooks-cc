import { afterEach, describe, expect, it, vi } from "vitest";
import { addressBytes, openDropSocket } from "./connect";

// Production never allows private targets; the rest of its environment is not needed here.
vi.mock("@/lib/forwarding/config", () => ({ allowPrivateTargets: () => false }));

describe("SOCKS address encoding", () => {
  it("encodes IPv4 and IPv6 literals, a dotted IPv4 tail included", () => {
    expect(addressBytes("203.0.113.5")).toEqual(Buffer.from([1, 203, 0, 113, 5]));
    const mapped = addressBytes("::ffff:203.0.113.5")!;
    expect(mapped[0]).toBe(4);
    expect(mapped.subarray(1).toString("hex")).toBe("00000000000000000000ffffcb007105");
    expect(addressBytes("0:0:0:0:0:ffff:cb00:7105")!.subarray(1).toString("hex")).toBe(
      "00000000000000000000ffffcb007105"
    );
    expect(addressBytes("2001:db8::1")!.subarray(1).toString("hex")).toBe(
      "20010db8000000000000000000000001"
    );
    expect(addressBytes("files.acme.example")).toBeNull();
  });
});

describe("openDropSocket in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to connect without the egress proxy, before any connection", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FILE_DROP_PROXY_URL", "");
    await expect(openDropSocket("files.acme.example", 22)).rejects.toThrow(
      "File drops are not set up on this server."
    );
  });
});
