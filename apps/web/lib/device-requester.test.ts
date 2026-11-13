import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ LOCATION_CITY_HEADER: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

import { compareNetworks, deviceRequester } from "./device-requester";

function request(headers: Record<string, string>): Request {
  return new Request("https://webhooks.cc/api/auth/device-code", { method: "POST", headers });
}

describe("deviceRequester", () => {
  it("records the client, the country and the network, never the address", () => {
    const requester = deviceRequester(
      request({
        "cf-connecting-ip": "203.0.113.7",
        "cf-ipcountry": "dk",
        "user-agent": "whk-cli/1.12.0",
      }),
      { client: "whk 1.13.0 on linux", remote: true }
    );
    expect(requester).toEqual({
      client: "whk 1.13.0 on linux",
      country: "DK",
      city: null,
      network: "203.0.113.0/24",
      remote: true,
    });
  });

  it("falls back to the user agent and drops what it cannot trust", () => {
    const requester = deviceRequester(
      request({ "cf-ipcountry": "XX", "user-agent": "whk-cli/1.11.0" }),
      { client: 42, remote: "yes" }
    );
    expect(requester.client).toBe("whk-cli/1.11.0");
    expect(requester.country).toBeNull();
    expect(requester.remote).toBe(false);
  });

  it("strips control and bidi characters from what the client says", () => {
    const requester = deviceRequester(request({}), {
      client: "whk\u0000 on ‮linux\n\nnow",
    });
    expect(requester.client).toBe("whk on linux now");
  });

  it("reads the city only from the header the edge is configured to set", () => {
    const headers = { "cf-ipcountry": "DK", "x-visitor-city": "Copenhagen" };
    expect(deviceRequester(request(headers), {}).city).toBeNull();
    env.LOCATION_CITY_HEADER = "x-visitor-city";
    try {
      expect(deviceRequester(request(headers), {}).city).toBe("Copenhagen");
    } finally {
      env.LOCATION_CITY_HEADER = undefined;
    }
  });

  it("counts an IPv6 client by its /48", () => {
    const requester = deviceRequester(request({ "cf-connecting-ip": "2001:db8:1:2::5" }), {});
    expect(requester.network).toBe("2001:0db8:0001::/48");
  });
});

describe("compareNetworks", () => {
  it("is same, different, or unknown across IP versions", () => {
    expect(compareNetworks("203.0.113.0/24", "203.0.113.0/24")).toBe("same");
    expect(compareNetworks("203.0.113.0/24", "198.51.100.0/24")).toBe("different");
    expect(compareNetworks("203.0.113.0/24", "2001:0db8:0001::/48")).toBe("unknown");
    expect(compareNetworks(null, "203.0.113.0/24")).toBe("unknown");
  });
});
