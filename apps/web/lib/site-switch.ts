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
 * is signed out on mailhooks.cc. Four stops:
 *
 * 1. POST /api/site-switch, on the site switched from, with the session's
 *    bearer token (so only the signed-in page itself can ask): a grant
 *    naming the account, good for a minute.
 * 2. /auth/switch/start, on the site switched to: sets a nonce cookie, then
 *    sends the browser back to the other site's issue with the nonce's hash
 *    and the grant.
 * 3. /auth/switch/issue, on the site switched from: only for the account
 *    the grant names, whose session cookie this browser holds there, has
 *    GoTrue make a one-time sign-in token (admin generateLink, which sends
 *    nothing) and seals it with the nonce hash, the account, the target and
 *    the page to land on into a ticket good for two minutes.
 * 4. /auth/switch/finish, on the site switched to: opens the ticket, checks
 *    the nonce cookie against its hash, and verifies the token, which puts a
 *    new session in this host's cookies.
 *
 * The grant means a page elsewhere cannot have a ticket made for someone's
 * account by sending their browser to issue: it has no grant for them. The
 * nonce ties a ticket to the browser that started the switch, so a ticket
 * made for one account (someone's own, planted in a link) signs no one in
 * from another browser; finish uses up a ticket it refuses, so a copy of it
 * cannot be tried again. GoTrue's token is never in a URL unsealed.
 */

const COOKIE_NAME = "whcc_site_switch";
/**
 * Over https the cookie is a __Host- cookie (Secure, Path=/, no Domain), so a
 * page on another subdomain of the same site cannot set one in its place.
 */
const SECURE_COOKIE_NAME = `__Host-${COOKIE_NAME}`;
/** The start to finish round trip, generously. */
const NONCE_LIFETIME_S = 300;
export const GRANT_LIFETIME_MS = 60 * 1000;
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
  return secure
    ? `${SECURE_COOKIE_NAME}=${nonce}; Path=/; Max-Age=${NONCE_LIFETIME_S}; HttpOnly; SameSite=Lax; Secure`
    : `${COOKIE_NAME}=${nonce}; Path=/auth/switch; Max-Age=${NONCE_LIFETIME_S}; HttpOnly; SameSite=Lax`;
}

export function clearSwitchCookie(secure: boolean): string {
  return secure
    ? `${SECURE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
    : `${COOKIE_NAME}=; Path=/auth/switch; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** The browser's nonce; over https only the __Host- cookie counts. */
export function switchNonceOf(request: Request, secure: boolean): string | null {
  const wanted = secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === wanted) return rest.join("=") || null;
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

/** What the signed-in page asked for: a switch of this account, soon. */
export interface SwitchGrant {
  userId: string;
  expires: number;
}

export interface SwitchTicket {
  /** GoTrue's hashed one-time token for the account (generateLink, magiclink). */
  tokenHash: string;
  /** The account, for the audit trail at finish. */
  userId: string;
  /** The hash of the nonce cookie set on the target. */
  nonce: string;
  /** The site the session is carried to. */
  to: SiteKey;
  /** The page to land on there, a path. */
  next: string;
  expires: number;
}

/** The ticket key from SIGNING_SECRET_KEY, or null when it is missing or not 32 bytes. */
function baseKey(): Buffer | null {
  const raw = process.env.SIGNING_SECRET_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/** Whether switches can be sealed here; checked before anything is asked of GoTrue. */
export function switchKeyConfigured(): boolean {
  return baseKey() !== null;
}

function keyFor(purpose: string): Buffer {
  const key = baseKey();
  if (!key) throw new Error("SIGNING_SECRET_KEY is not a 32-byte base64 key");
  return createHash("sha256").update(key).update(purpose).digest();
}

// Grants and tickets are sealed under keys of their own, so neither passes for the other.
const GRANT_PURPOSE = "site switch grant";
const TICKET_PURPOSE = "site switch ticket";

function seal(purpose: string, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

function open(purpose: string, sealed: string): unknown {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const json = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function sealGrant(grant: SwitchGrant): string {
  return seal(GRANT_PURPOSE, grant);
}

/** The grant, or null when it is not one of ours, has been changed or has expired. */
export function openGrant(sealed: string, now = Date.now()): SwitchGrant | null {
  const grant = open(GRANT_PURPOSE, sealed) as SwitchGrant | null;
  if (!grant || typeof grant.userId !== "string" || typeof grant.expires !== "number") {
    return null;
  }
  return grant.expires > now ? grant : null;
}

export function sealTicket(ticket: SwitchTicket): string {
  return seal(TICKET_PURPOSE, ticket);
}

/** The ticket, or null when it is not one of ours, has been changed or has expired. */
export function openTicket(sealed: string, now = Date.now()): SwitchTicket | null {
  const ticket = open(TICKET_PURPOSE, sealed) as SwitchTicket | null;
  if (
    !ticket ||
    typeof ticket.tokenHash !== "string" ||
    typeof ticket.userId !== "string" ||
    typeof ticket.nonce !== "string" ||
    (ticket.to !== "webhooks" && ticket.to !== "mailhooks") ||
    typeof ticket.next !== "string" ||
    typeof ticket.expires !== "number"
  ) {
    return null;
  }
  return ticket.expires > now ? ticket : null;
}
