import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Where forwarded email may go when it is sent directly rather than through
 * the notify proxy: the receiver's rules for notifications
 * (apps/receiver-rs/src/handlers/webhook.rs), so a URL cannot reach the
 * box's own network. With `allowPrivate` (development only) http and local
 * addresses pass too, so forwarding can be tried against a local server.
 */

/** The receiver's BLOCKED_NOTIFICATION_PORTS. */
export const BLOCKED_PORTS = new Set([
  22, 23, 25, 135, 139, 389, 445, 636, 3306, 3389, 5432, 5672, 5900, 6379, 9200, 9300, 11211, 15672,
  27017, 27018, 27019,
]);

// Separate lists: Node's BlockList applies an IPv6 rule for ::ffff:0:0/96 to
// plain IPv4 addresses too.
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  // Ranges that carry an IPv4 address, however it is spelled ("::ffff:7f00:1"
  // is 127.0.0.1): IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo. A
  // forwarding target has no reason to resolve to any of them.
  ["::ffff:0:0", 96],
  ["::", 96],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["2001::", 32],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

/**
 * Loopback, private, link-local (cloud metadata included), CGNAT, multicast,
 * unspecified, or an IPv6 address that carries an IPv4 one.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return BLOCKED_V6.check(address, "ipv6");
  return true;
}

function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** The checks that need no DNS: scheme, host and port. */
export function checkForwardUrl(raw: string, options: { allowPrivate: boolean }): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Enter a full URL, like https://example.com/hooks/email." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Put credentials in your server's config, not in the URL." };
  }
  const httpAllowed = options.allowPrivate && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) {
    return { ok: false, reason: "The URL must use https." };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowPrivate && (isLocalName(host) || isIP(host) !== 0)) {
    return { ok: false, reason: "Use a public host name, not localhost or an IP address." };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    return { ok: false, reason: `Port ${port} is not allowed.` };
  }
  return { ok: true, url };
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves the host once and checks every address it returns, so the
 * connection can be pinned to them (see send.ts): a name that resolves to a
 * private address, now or on a second lookup, is refused.
 */
export async function resolveForwardTarget(
  url: URL,
  options: { allowPrivate: boolean }
): Promise<ResolvedAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: host, family: literal as 4 | 6 }]
    : (await lookup(host, { all: true, verbatim: true })).map((entry) => ({
        address: entry.address,
        family: entry.family as 4 | 6,
      }));
  if (addresses.length === 0) throw new Error("The host name has no addresses.");
  if (!options.allowPrivate && addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("The host name points at a private or reserved address.");
  }
  return addresses;
}
