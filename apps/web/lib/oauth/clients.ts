import { customAlphabet } from "nanoid";
import { sendOptions } from "@/lib/forwarding/config";
import { sendForward } from "@/lib/forwarding/send";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * OAuth clients of the authorization server (remote MCP clients). Two kinds:
 *
 * - A Client ID Metadata Document (the MCP spec's preferred registration):
 *   the client_id is an https URL serving the client's metadata, so the
 *   client is identified by a host it controls. Fetched through the notify
 *   proxy when one is configured (the box's IP stays hidden), else directly
 *   with the forwarding SSRF rules, and kept in memory for a few minutes.
 * - Dynamic Client Registration (RFC 7591, deprecated by MCP 2026-07-28 but
 *   still what many clients do): a `whoc_` id stored in oauth_clients. Its
 *   name is self-reported and shown as such.
 *
 * Every client is public: PKCE (S256) instead of a secret.
 */

export interface OAuthClient {
  clientId: string;
  /** The client's name. Self-reported for a registered client. */
  name: string | null;
  /** The host that vouches for the client (its metadata document's), or null. */
  verifiedHost: string | null;
  clientUri: string | null;
  redirectUris: string[];
  kind: "metadata_document" | "registered";
}

const DCR_PREFIX = "whoc_";
const generateDcrId = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;
/**
 * Private-use schemes of apps that take OAuth redirects themselves. Any
 * other app scheme must be reverse-domain (com.example.app, RFC 8252 7.1),
 * so a redirect can never launch an arbitrary protocol handler (intent:,
 * ms-msdt:, search-ms:, ...) from a webhooks.cc page.
 */
const APP_SCHEMES = new Set([
  "cursor:",
  "vscode:",
  "vscode-insiders:",
  "vscodium:",
  "windsurf:",
  "claude:",
  "zed:",
  "kiro:",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Redirect URIs a client registers, joined; keeps a registration row small. */
const MAX_REDIRECT_URIS_LENGTH = 4096;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hosts a client can never be on or send the human to: this app and the
 * receiver. Anyone can serve a document from a capture endpoint, which would
 * then read as "identified by go.webhooks.cc".
 */
function ownHosts(): string[] {
  return [
    hostOf(process.env.NEXT_PUBLIC_APP_URL),
    hostOf(process.env.NEXT_PUBLIC_WEBHOOK_URL),
  ].filter((host): host is string => host !== null);
}

function isOwnHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return ownHosts().some((own) => host === own || host.endsWith(`.${own}`));
}

const METADATA_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
/** The proxy and the direct path both return the first 1024 bytes. */
const MAX_METADATA_BYTES = 1024;

/** Thrown when a client's metadata cannot be used; the message is for the human. */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

/**
 * A redirect URI a client may register: absolute, no fragment, and not a
 * scheme that runs code. http only for loopback (native apps, RFC 8252);
 * private-use schemes (cursor://, vscode://) are fine.
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URI_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#") || url.username || url.password) return false;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:") return url.hostname.length > 0 && !isOwnHost(url.hostname);
  return APP_SCHEMES.has(url.protocol) || /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

/**
 * Whether a requested redirect URI matches a registered one: exactly, or for
 * loopback http with any port (RFC 8252 7.3, native apps pick a free port).
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (asked.protocol !== "http:" || !LOOPBACK_HOSTS.has(asked.hostname)) return false;
  return registered.some((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        url.protocol === "http:" &&
        url.hostname === asked.hostname &&
        url.pathname === asked.pathname &&
        url.search === asked.search
      );
    } catch {
      return false;
    }
  });
}

/**
 * Whether a client_id is a Client ID Metadata Document URL: https, a path
 * beyond "/", no credentials, fragment or dot segments.
 */
export function isMetadataDocumentClientId(clientId: string): boolean {
  if (clientId.length > MAX_URI_LENGTH || clientId.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.pathname === "/" || url.pathname === "") return false;
  if (isOwnHost(url.hostname)) return false;
  const segments = clientId.slice(clientId.indexOf("//") + 2).split(/[/?]/);
  return !segments.some((segment) => segment === "." || segment === "..");
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control and format characters (bidi overrides, zero-width) could
  // disguise a name on the consent page.
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return cleaned ? cleaned.slice(0, MAX_NAME_LENGTH) : null;
}

function cleanUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URI_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client ID Metadata Documents
// ---------------------------------------------------------------------------

const cache = new Map<string, { client: OAuthClient | null; reason?: string; until: number }>();

function remember(clientId: string, client: OAuthClient | null, reason?: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(clientId, {
    client,
    reason,
    until: Date.now() + (client ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
  });
}

/** Drops cached metadata (tests). */
export function clearClientCache(): void {
  cache.clear();
}

/** Checks a fetched metadata document; throws ClientMetadataError with the reason. */
export function parseMetadataDocument(clientId: string, text: string): OAuthClient {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ClientMetadataError(
      text.length >= MAX_METADATA_BYTES
        ? `The client's metadata document is larger than ${MAX_METADATA_BYTES} bytes.`
        : "The client's metadata document is not JSON."
    );
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ClientMetadataError("The client's metadata document is not a JSON object.");
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) {
    throw new ClientMetadataError("The client's metadata document names another client_id.");
  }
  if ("client_secret" in doc || "client_secret_expires_at" in doc) {
    throw new ClientMetadataError("The client's metadata document carries a secret.");
  }
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new ClientMetadataError(
      "This server takes public clients only (token_endpoint_auth_method none)."
    );
  }
  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(validRedirectUri)
  ) {
    throw new ClientMetadataError("The client's metadata document has no usable redirect_uris.");
  }
  return {
    clientId,
    name: cleanName(doc.client_name),
    verifiedHost: new URL(clientId).host,
    clientUri: cleanUri(doc.client_uri),
    redirectUris,
    kind: "metadata_document",
  };
}

async function fetchMetadataDocument(clientId: string): Promise<OAuthClient> {
  const cached = cache.get(clientId);
  if (cached && cached.until > Date.now()) {
    if (cached.client) return cached.client;
    throw new ClientMetadataError(cached.reason ?? "The client's metadata could not be read.");
  }

  let text: string;
  try {
    const result = await sendForward(
      {
        method: "GET",
        url: clientId,
        headers: [
          ["accept", "application/json"],
          ["user-agent", "webhooks.cc OAuth (client metadata)"],
        ],
        body: null,
        mode: "relay",
      },
      { ...sendOptions(), timeoutMs: METADATA_TIMEOUT_MS }
    );
    if (result.error || result.status !== 200 || !result.excerpt) {
      throw new ClientMetadataError(
        result.error
          ? `The client's metadata document could not be fetched: ${result.error}`
          : `The client's metadata document answered HTTP ${result.status ?? "nothing"}.`
      );
    }
    text = result.excerpt;
  } catch (error) {
    const reason =
      error instanceof ClientMetadataError
        ? error.message
        : "The client's metadata document could not be fetched.";
    remember(clientId, null, reason);
    throw new ClientMetadataError(reason);
  }

  try {
    const client = parseMetadataDocument(clientId, text);
    remember(clientId, client);
    return client;
  } catch (error) {
    if (error instanceof ClientMetadataError) remember(clientId, null, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

async function loadRegisteredClient(clientId: string): Promise<OAuthClient | null> {
  if (!/^whoc_[A-Za-z0-9]{32}$/.test(clientId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("oauth_clients")
    .select("client_id, client_name, client_uri, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    clientId: data.client_id,
    name: data.client_name,
    verifiedHost: null,
    clientUri: data.client_uri,
    redirectUris: data.redirect_uris,
    kind: "registered",
  };
}

/** Marks a registered client as used, so the cleanup keeps it. */
export async function touchRegisteredClient(clientId: string): Promise<void> {
  if (!clientId.startsWith(DCR_PREFIX)) return;
  const admin = createAdminClient();
  const { error } = await admin
    .from("oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId);
  if (error) throw error;
}

/**
 * The client behind a client_id, or null when there is none. Throws
 * ClientMetadataError when a metadata document cannot be used.
 */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (clientId.startsWith(DCR_PREFIX)) return loadRegisteredClient(clientId);
  if (isMetadataDocumentClientId(clientId)) return fetchMetadataDocument(clientId);
  return null;
}

export interface RegistrationRequestError {
  error: "invalid_redirect_uri" | "invalid_client_metadata";
  description: string;
}

export interface RegisteredClientResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type?: string;
}

/**
 * RFC 7591 registration. Every client is registered public: a request for a
 * secret-based method gets `none` back (RFC 7591 3.2.1 lets the server
 * replace requested metadata), and PKCE does the rest.
 */
export async function registerClient(
  body: Record<string, unknown>
): Promise<RegisteredClientResponse | RegistrationRequestError> {
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS
  ) {
    return {
      error: "invalid_redirect_uri",
      description: `Send 1 to ${MAX_REDIRECT_URIS} redirect_uris.`,
    };
  }
  if (
    !redirectUris.every(validRedirectUri) ||
    redirectUris.join(" ").length > MAX_REDIRECT_URIS_LENGTH
  ) {
    return {
      error: "invalid_redirect_uri",
      description:
        "Each redirect URI must be absolute without a fragment: https (not on webhooks.cc), http on localhost, or an app's own reverse-domain scheme.",
    };
  }
  const grantTypes = body.grant_types;
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))
  ) {
    return {
      error: "invalid_client_metadata",
      description: "grant_types must include authorization_code.",
    };
  }
  const responseTypes = body.response_types;
  if (
    responseTypes !== undefined &&
    (!Array.isArray(responseTypes) || !responseTypes.includes("code"))
  ) {
    return { error: "invalid_client_metadata", description: "response_types must include code." };
  }

  const clientId = `${DCR_PREFIX}${generateDcrId()}`;
  const name = cleanName(body.client_name);
  const clientUri = cleanUri(body.client_uri);
  const admin = createAdminClient();
  const { error } = await admin.from("oauth_clients").insert({
    client_id: clientId,
    client_name: name,
    client_uri: clientUri,
    redirect_uris: redirectUris,
  });
  if (error) throw error;

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(name ? { client_name: name } : {}),
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(typeof body.application_type === "string"
      ? { application_type: body.application_type.slice(0, 20) }
      : {}),
  };
}
