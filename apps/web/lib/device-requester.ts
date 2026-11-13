import { serverEnv } from "@/lib/env";
import { getClientIp, rateLimitWideIpBucket } from "@/lib/rate-limit";

/**
 * Who asked for a device login, as the approval page shows it. The person
 * compares the code instead of typing it, so this is what tells a login they
 * started apart from a link someone sent them: which client, from where,
 * and whether it came from the network they are on now.
 */
export interface DeviceRequester {
  /** What the client says it is ("whk 1.13.0 on linux"); not a proof. */
  client: string | null;
  /** ISO 3166 code from Cloudflare (CF-IPCountry); T1 is Tor. */
  country: string | null;
  city: string | null;
  /** The /24 (IPv4) or /48 (IPv6) the request came from, never the address. */
  network: string | null;
  /** The login said it runs on another machine (`whk auth login --remote`). */
  remote: boolean;
}

/** Printable text only, trimmed and cut to `max` characters. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control characters (a line break among them, so they become spaces) and
  // the bidi overrides that could reorder what the page shows.
  const text = value
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

export function networkOf(request: Request): string | null {
  const ip = getClientIp(request);
  return ip === "unknown" ? null : rateLimitWideIpBucket(ip);
}

/**
 * The requester of a device login. `client` and `remote` come from the
 * request body (`whk auth login` sends both; older clients send neither, and
 * then the user agent names the client).
 */
export function deviceRequester(
  request: Request,
  body: { client?: unknown; remote?: unknown }
): DeviceRequester {
  const country = request.headers.get("cf-ipcountry")?.trim().toUpperCase() ?? "";
  const cityHeader = serverEnv().LOCATION_CITY_HEADER;
  return {
    client: clean(body.client, 120) ?? clean(request.headers.get("user-agent"), 120),
    // XX is Cloudflare's "unknown".
    country: /^[A-Z][A-Z0-9]$/.test(country) && country !== "XX" ? country : null,
    city: cityHeader ? clean(request.headers.get(cityHeader), 80) : null,
    network: networkOf(request),
    remote: body.remote === true,
  };
}

export type NetworkMatch = "same" | "different" | "unknown";

/**
 * Whether the approving browser is on the requester's network. Unknown when
 * either side has no address or they use different IP versions (a dual-stack
 * machine can reach us over IPv4 from the terminal and IPv6 from the
 * browser), so the page only warns on a real difference.
 */
export function compareNetworks(requester: string | null, approver: string | null): NetworkMatch {
  if (!requester || !approver) return "unknown";
  const v6 = (network: string) => network.includes(":");
  if (v6(requester) !== v6(approver)) return "unknown";
  return requester === approver ? "same" : "different";
}
