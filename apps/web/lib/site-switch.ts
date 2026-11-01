import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { SiteKey } from "@/lib/site";

/**
 * Carrying a session from one site to the other, for the header's switcher.
 * Sessions are per host (lib/site.ts), so a browser signed in on webhooks.cc
 * is signed out on mailhooks.cc. Three stops, all under /auth/switch:
 *
 * 1. start, on the site switched to: sets an HttpOnly nonce cookie, then
 *    sends the browser to the other site's issue with the nonce's hash.
 * 2. issue, on the site switched from: reads the browser's session there,
 *    has GoTrue make a one-time sign-in token for that account (admin
 *    generateLink, which sends nothing), and seals it with the nonce hash,
 *    the target and the page to land on into a ticket good for two minutes,
 *    then sends the browser to the target's finish.
 * 3. finish, back on the site switched to: opens the ticket, checks the
 *    nonce cookie against its hash, and verifies the token, which puts a new
 *    session in this host's cookies.
 *
 * The nonce ties a ticket to the browser that started the switch: a ticket
 * someone else made (for their own account) does not match the cookie in
 * yours, so a planted link cannot sign anyone into another account, and a
 * ticket only ever travels to the browser it was made for. GoTrue's token
 * is never in a URL unsealed.
 */

export const SWITCH_COOKIE = "whcc_site_switch";
const COOKIE_PATH = "/auth/switch";
/** The start to finish round trip, generously. */
const NONCE_LIFETIME_S = 300;
export const TICKET_LIFETIME_MS = 2 * 60 * 1000;

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function nonceHash(nonce: string): string {
  return createHash("sha256").update(`site switch ${nonce}`).digest("base64url");
}

/** A nonce hash as it travels in the issue URL (43 base64url characters). */
export function isNonceHash(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function switchCookie(nonce: string, secure: boolean): string {
  return `${SWITCH_COOKIE}=${nonce}; Path=${COOKIE_PATH}; Max-Age=${NONCE_LIFETIME_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSwitchCookie(secure: boolean): string {
  return `${SWITCH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function switchNonceOf(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SWITCH_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** Whether the browser's nonce is the one the ticket was made for. */
export function nonceMatches(nonce: string | null, expectedHash: string): boolean {
  if (!nonce) return false;
  const actual = Buffer.from(nonceHash(nonce));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface SwitchTicket {
  /** GoTrue's hashed one-time token for the account (generateLink, magiclink). */
  tokenHash: string;
  /** The hash of the nonce cookie set on the target. */
  nonce: string;
  /** The site the session is carried to. */
  to: SiteKey;
  /** The page to land on there, a path. */
  next: string;
  expires: number;
}

function ticketKey(): Buffer {
  const raw = process.env.SIGNING_SECRET_KEY;
  if (!raw) throw new Error("SIGNING_SECRET_KEY is not configured");
  return createHash("sha256")
    .update(Buffer.from(raw, "base64"))
    .update("site switch ticket")
    .digest();
}

export function sealTicket(ticket: SwitchTicket): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ticketKey(), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(ticket), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

/** The ticket, or null when it is not one of ours, has been changed or has expired. */
export function openTicket(sealed: string, now = Date.now()): SwitchTicket | null {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const json = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    const ticket = JSON.parse(json) as SwitchTicket;
    if (
      typeof ticket.tokenHash !== "string" ||
      typeof ticket.nonce !== "string" ||
      (ticket.to !== "webhooks" && ticket.to !== "mailhooks") ||
      typeof ticket.next !== "string" ||
      typeof ticket.expires !== "number"
    ) {
      return null;
    }
    return ticket.expires > now ? ticket : null;
  } catch {
    return null;
  }
}
