import { describe, expect, it } from "vitest";
import { checkForwardUrl, isBlockedAddress, resolveForwardTarget } from "./target";

describe("isBlockedAddress", () => {
  it("blocks private, loopback, link-local, CGNAT, multicast and unspecified addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.7",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("checkForwardUrl", () => {
  const strict = { allowPrivate: false };

  it("accepts a public https URL", () => {
    expect(checkForwardUrl("https://api.example.com/hooks/email?x=1", strict).ok).toBe(true);
  });

  it("refuses http, local names, IP literals, blocked ports and credentials", () => {
    expect(checkForwardUrl("http://api.example.com/x", strict)).toMatchObject({ ok: false });
    expect(checkForwardUrl("https://localhost/x", strict)).toMatchObject({ ok: false });
    expect(checkForwardUrl("https://app.localhost/x", strict)).toMatchObject({ ok: false });
    expect(checkForwardUrl("https://10.0.0.5/x", strict)).toMatchObject({ ok: false });
    expect(checkForwardUrl("https://[::1]/x", strict)).toMatchObject({ ok: false });
    expect(checkForwardUrl("https://api.example.com:6379/x", strict)).toMatchObject({
      ok: false,
      reason: "Port 6379 is not allowed.",
    });
    expect(checkForwardUrl("https://user:pass@api.example.com/x", strict)).toMatchObject({
      ok: false,
    });
    expect(checkForwardUrl("not a url", strict)).toMatchObject({ ok: false });
  });

  it("allows http and local addresses only when told to", () => {
    expect(checkForwardUrl("http://127.0.0.1:4000/hook", { allowPrivate: true }).ok).toBe(true);
  });
});

describe("resolveForwardTarget", () => {
  it("refuses a name that resolves to a private address", async () => {
    await expect(
      resolveForwardTarget(new URL("https://localhost/x"), { allowPrivate: false })
    ).rejects.toThrow(/private or reserved/);
  });

  it("returns literal addresses without a lookup", async () => {
    await expect(
      resolveForwardTarget(new URL("http://127.0.0.1:1/x"), { allowPrivate: true })
    ).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
  });
});
