import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { publicEnv } from "@/lib/env";

/**
 * Google, for the Sheets destination. The narrowest scope that works:
 * drive.file lets the app use only the spreadsheets it created (or that the
 * user picked for it), never the rest of anyone's Drive; openid and email
 * say which account was connected. Authorization code with PKCE; the state
 * is encrypted with SIGNING_SECRET_KEY and carries the user, the verifier
 * and where to return, so nothing is stored until Google answers.
 *
 * Cells are written with valueInputOption=RAW: an email's subject starting
 * with "=" stays text and never becomes a formula in someone's sheet.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
] as const;

const STATE_LIFETIME_MS = 15 * 60_000;

/** Overridable for tests, which stand up a local fake. */
function urls() {
  return {
    auth: process.env.GOOGLE_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    token: process.env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token",
    revoke: process.env.GOOGLE_OAUTH_REVOKE_URL || "https://oauth2.googleapis.com/revoke",
    sheets: (process.env.GOOGLE_SHEETS_API_URL || "https://sheets.googleapis.com").replace(
      /\/+$/,
      ""
    ),
  };
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** For the Drive Picker in the browser; optional. */
  pickerApiKey: string | null;
  /** The Cloud project number, the Picker's app id; optional. */
  projectNumber: string | null;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY?.trim() || null,
    projectNumber: process.env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim() || null,
  };
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** The grant is gone (revoked, expired): the user must connect again. */
    readonly reconnect = false
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

export function callbackUrl(appUrl = publicEnv().NEXT_PUBLIC_APP_URL): string {
  return `${appUrl.replace(/\/+$/, "")}/api/integrations/google/callback`;
}

function stateKey(): Buffer {
  const raw = process.env.SIGNING_SECRET_KEY;
  if (!raw) throw new GoogleError("SIGNING_SECRET_KEY is not configured");
  return createHash("sha256")
    .update(Buffer.from(raw, "base64"))
    .update("google oauth state")
    .digest();
}

export interface OAuthState {
  userId: string;
  verifier: string;
  returnTo: string;
  expires: number;
  /**
   * The hash of a nonce kept in an HttpOnly cookie of the browser that
   * started the flow. The callback needs both, so a consent URL started by
   * one person cannot link the Google account of another who opens it.
   */
  browser: string;
  /** The site the flow started on (lib/site.ts), where it returns to. */
  site?: "webhooks" | "mailhooks";
  /**
   * Started on mailhooks.cc: the hash of the handoff cookie set there. The
   * connection is saved on mailhooks.cc only for the browser holding it.
   */
  handoff?: string;
}

/** The cookie that ties a callback to the browser that started it. */
export const BROWSER_COOKIE = "whcc_google_oauth";

export function browserHash(nonce: string): string {
  return createHash("sha256").update(`google oauth browser ${nonce}`).digest("base64url");
}

export function sealState(state: OAuthState): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

export function openState(sealed: string, now = Date.now()): OAuthState | null {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", stateKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const json = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    const state = JSON.parse(json) as OAuthState;
    if (
      typeof state.userId !== "string" ||
      typeof state.verifier !== "string" ||
      typeof state.browser !== "string"
    ) {
      return null;
    }
    return state.expires > now ? state : null;
  } catch {
    return null;
  }
}

/**
 * Starting on mailhooks.cc: Google returns to webhooks.cc's callback (the
 * one redirect URI registered), which reads the nonce cookie of its own
 * host. So the browser makes two stops on the way out: webhooks.cc's begin
 * sets that cookie, then mailhooks.cc's handoff checks a cookie the start
 * set on mailhooks.cc (HANDOFF_COOKIE) and only then goes on to Google. On
 * the way back, webhooks.cc's callback saves nothing: it seals the code for
 * mailhooks.cc's finish, which saves the connection only for the browser
 * holding that same handoff cookie. So completing a flow needs the browser
 * that started it, whatever links someone else plants.
 *
 * The begin ticket carries the consent URL, the callback nonce and the
 * handoff nonce's hash; the finish ticket the code and the state. Both are
 * sealed under keys of their own (neither passes for the other or for a
 * state) and good for two minutes.
 */
export const HANDOFF_COOKIE = "whcc_google_handoff";

/** For the handoff and the finish, as long as the state lasts. */
export function handoffCookie(nonce: string, secure: boolean): string {
  return `${HANDOFF_COOKIE}=${nonce}; Path=/api/integrations/google; Max-Age=${STATE_LIFETIME_MS / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearHandoffCookie(secure: boolean): string {
  return `${HANDOFF_COOKIE}=; Path=/api/integrations/google; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function handoffNonceOf(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === HANDOFF_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export function handoffHash(nonce: string): string {
  return createHash("sha256").update(`google oauth handoff ${nonce}`).digest("base64url");
}
const TICKET_LIFETIME_MS = 2 * 60 * 1000;

function ticketKey(purpose = "google oauth begin ticket"): Buffer {
  const raw = process.env.SIGNING_SECRET_KEY;
  if (!raw) throw new GoogleError("SIGNING_SECRET_KEY is not configured");
  return createHash("sha256").update(Buffer.from(raw, "base64")).update(purpose).digest();
}

function sealWith(purpose: string, value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ticketKey(purpose), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

function openWith(purpose: string, sealed: string): unknown {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(purpose), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8")
    );
  } catch {
    return null;
  }
}

const FINISH = "google oauth finish ticket";

/** The way back to mailhooks.cc: Google's code and the flow's state. */
export function sealFinishTicket(code: string, state: OAuthState, now = Date.now()): string {
  return sealWith(FINISH, { code, state, expires: now + TICKET_LIFETIME_MS });
}

export function openFinishTicket(
  sealed: string,
  now = Date.now()
): { code: string; state: OAuthState } | null {
  const ticket = openWith(FINISH, sealed) as {
    code?: unknown;
    state?: OAuthState;
    expires?: unknown;
  } | null;
  if (
    !ticket ||
    typeof ticket.code !== "string" ||
    typeof ticket.expires !== "number" ||
    ticket.expires <= now ||
    !ticket.state ||
    typeof ticket.state.userId !== "string" ||
    typeof ticket.state.verifier !== "string" ||
    typeof ticket.state.handoff !== "string"
  ) {
    return null;
  }
  return { code: ticket.code, state: ticket.state };
}

export function sealBeginTicket(
  url: string,
  browserNonce: string,
  handoff: string,
  now = Date.now()
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ticketKey(), nonce);
  const body = Buffer.concat([
    cipher.update(
      JSON.stringify({ url, browserNonce, handoff, expires: now + TICKET_LIFETIME_MS }),
      "utf8"
    ),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
}

export function openBeginTicket(
  sealed: string,
  now = Date.now()
): { url: string; browserNonce: string; handoff: string } | null {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const ticket = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8")
    ) as { url?: unknown; browserNonce?: unknown; handoff?: unknown; expires?: unknown };
    if (
      typeof ticket.url !== "string" ||
      typeof ticket.browserNonce !== "string" ||
      typeof ticket.handoff !== "string" ||
      typeof ticket.expires !== "number" ||
      ticket.expires <= now ||
      // Only ever on to Google's consent page.
      new URL(ticket.url).origin !== new URL(urls().auth).origin
    ) {
      return null;
    }
    return { url: ticket.url, browserNonce: ticket.browserNonce, handoff: ticket.handoff };
  } catch {
    return null;
  }
}

/** Only paths on this app: a return address must never leave it. */
export function safeReturnPath(value: unknown): string {
  return typeof value === "string" && /^\/(?!\/)[^\s\\]*$/.test(value) && value.length <= 500
    ? value
    : "/dashboard";
}

/**
 * Where to send the browser to connect a Google account, and the nonce to
 * set as the BROWSER_COOKIE in that browser.
 */
export function authorizationUrl(
  config: GoogleConfig,
  userId: string,
  returnTo: string,
  site: "webhooks" | "mailhooks" = "webhooks",
  handoff?: string
): { url: string; browserNonce: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const browserNonce = randomBytes(24).toString("base64url");
  const state = sealState({
    userId,
    verifier,
    returnTo: safeReturnPath(returnTo),
    expires: Date.now() + STATE_LIFETIME_MS,
    browser: browserHash(browserNonce),
    site,
    ...(handoff ? { handoff } : {}),
  });
  const url = new URL(urls().auth);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  // A refresh token every time, so connecting again repairs a revoked grant.
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString(), browserNonce };
}

/** The cookie header value that holds the nonce for the callback, for 15 minutes. */
export function browserCookie(nonce: string, secure: boolean): string {
  return `${BROWSER_COOKIE}=${nonce}; Path=/api/integrations/google/callback; Max-Age=${STATE_LIFETIME_MS / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** A cookie header that removes the nonce. */
export function clearBrowserCookie(secure: boolean): string {
  return `${BROWSER_COOKIE}=; Path=/api/integrations/google/callback; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The nonce cookie of a request, if any. */
export function browserNonceOf(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === BROWSER_COOKIE) return rest.join("=") || null;
  }
  return null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(urls().token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!response.ok || !data.access_token) {
    throw new GoogleError(
      `Google refused the token request (${data.error ?? response.status})`,
      response.status,
      data.error === "invalid_grant"
    );
  }
  return data;
}

export interface ConnectedAccount {
  sub: string;
  email: string | null;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scopes: string;
}

/** The ID token's claims, read without verifying: it came straight from Google over TLS. */
function idTokenClaims(idToken: string | undefined): { sub?: string; email?: string } {
  if (!idToken) return {};
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  verifier: string
): Promise<ConnectedAccount> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: callbackUrl(),
  });
  const claims = idTokenClaims(tokens.id_token);
  if (!tokens.refresh_token) throw new GoogleError("Google sent no refresh token");
  if (!claims.sub) throw new GoogleError("Google did not say which account was connected");
  const scopes = tokens.scope ?? "";
  if (!scopes.split(" ").includes("https://www.googleapis.com/auth/drive.file")) {
    throw new GoogleError("Allow webhooks.cc to use the spreadsheets it creates, then try again.");
  }
  return {
    sub: claims.sub,
    email: claims.email ?? null,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes,
  };
}

/** Access tokens by refresh token's hash, reused until a minute before they expire. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export async function accessToken(config: GoogleConfig, refreshToken: string): Promise<string> {
  const key = createHash("sha256").update(refreshToken).digest("hex");
  const cached = accessTokens.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (accessTokens.size > 1000) accessTokens.clear();
  accessTokens.set(key, {
    token: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}

export async function revokeToken(refreshToken: string): Promise<void> {
  await fetch(urls().revoke, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function sheetsCall<T>(
  token: string,
  path: string,
  init: { method: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`${urls().sheets}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; status?: string };
  };
  if (!response.ok) {
    const message = data.error?.message ?? `Google Sheets answered ${response.status}`;
    throw new GoogleError(message, response.status, response.status === 401);
  }
  return data;
}

/** Creates a spreadsheet with one sheet and the header row. */
export async function createSpreadsheet(
  token: string,
  title: string,
  sheetTitle: string,
  headers: string[]
): Promise<{ id: string; url: string }> {
  const created = await sheetsCall<{ spreadsheetId: string; spreadsheetUrl: string }>(
    token,
    "/v4/spreadsheets",
    {
      method: "POST",
      body: {
        properties: { title: title.slice(0, 200) },
        sheets: [{ properties: { title: sheetTitle, gridProperties: { frozenRowCount: 1 } } }],
      },
    }
  );
  if (headers.length > 0) await writeHeader(token, created.spreadsheetId, sheetTitle, headers);
  return { id: created.spreadsheetId, url: created.spreadsheetUrl };
}

/** A sheet name as A1 notation wants it. */
export function quotedSheet(sheet: string): string {
  return `'${sheet.replace(/'/g, "''")}'`;
}

export async function writeHeader(
  token: string,
  spreadsheetId: string,
  sheet: string,
  headers: string[]
): Promise<void> {
  const range = encodeURIComponent(`${quotedSheet(sheet)}!A1`);
  await sheetsCall(
    token,
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=RAW`,
    { method: "PUT", body: { values: [headers] } }
  );
}

/** Appends rows below the sheet's table, as text (never formulas). */
export async function appendRows(
  token: string,
  spreadsheetId: string,
  sheet: string,
  rows: string[][]
): Promise<number> {
  const range = encodeURIComponent(`${quotedSheet(sheet)}!A1`);
  const result = await sheetsCall<{ updates?: { updatedRows?: number } }>(
    token,
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: rows } }
  );
  return result.updates?.updatedRows ?? rows.length;
}

/** The spreadsheet id in a Google Sheets URL, or null. */
export function spreadsheetIdOf(url: string): string | null {
  const match =
    /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:[/?#]|$)/.exec(url);
  return match ? match[1] : null;
}

export function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
