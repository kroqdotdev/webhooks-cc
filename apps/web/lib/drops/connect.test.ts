import { describe, expect, it } from "vitest";
import { addressBytes } from "./connect";

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
