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
      // Any IPv4-mapped address, public ones too: a target has no reason to use one.
      "::ffff:8.8.8.8",
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "not-an-ip",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const address of [
      "93.184.216.34",
      "1.1.1.1",
      "2606:4700:4700::1111",
      "2a00:1450:4001::64",
    ]) {
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

  it("refuses the receiver itself, however the host is spelled", () => {
    const receiver = { allowPrivate: false, receiverUrl: "https://go.example.com" };
    for (const url of [
      "https://go.example.com/w/acme-orders",
      "https://GO.example.com./w/acme-orders",
      "https://go.example.com:443/w/acme-orders/stripe",
    ]) {
      expect(checkForwardUrl(url, receiver), url).toMatchObject({
        ok: false,
        reason: expect.stringContaining("capture URL"),
      });
    }
    expect(checkForwardUrl("https://example.com/w/acme-orders", receiver).ok).toBe(true);
    expect(checkForwardUrl("https://go.example.com:8443/w/x", receiver).ok).toBe(true);
    const local = { allowPrivate: true, receiverUrl: "http://localhost:3001" };
    expect(checkForwardUrl("http://localhost:3001/w/acme-orders", local).ok).toBe(false);
    expect(checkForwardUrl("http://localhost:4000/hook", local).ok).toBe(true);
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
