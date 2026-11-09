import { describe, expect, it } from "vitest";
import { hexDump, requestBodyBytes } from "./body-bytes";

describe("requestBodyBytes", () => {
  it("prefers the exact raw bytes", () => {
    const bytes = requestBodyBytes({ body: "�", bodyRaw: btoa("\xff\x00A") });
    expect(Array.from(bytes ?? [])).toEqual([0xff, 0x00, 0x41]);
  });

  it("encodes a text body as UTF-8", () => {
    expect(Array.from(requestBodyBytes({ body: "é" }) ?? [])).toEqual([0xc3, 0xa9]);
  });

  it("returns null without a body", () => {
    expect(requestBodyBytes({})).toBeNull();
  });
});

describe("hexDump", () => {
  it("prints offset, hex and printable ASCII", () => {
    const dump = hexDump(new Uint8Array([0x48, 0x69, 0x00, 0xff]));
    expect(dump).toBe(`00000000  48 69 00 ff${" ".repeat(36)}  Hi..`);
  });

  it("stops at the limit", () => {
    const dump = hexDump(new Uint8Array(64), 32);
    expect(dump.split("\n")).toHaveLength(2);
  });
});
