/**
 * Cloudflare Worker: outbound notification proxy.
 *
 * The receiver POSTs here instead of directly to Slack/Discord/etc.
 * This worker relays the request so the destination sees a Cloudflare
 * edge IP instead of the origin server's real IP.
 *
 * Two modes:
 * - Notifications (the receiver): the body is relayed with fixed headers and
 *   the answer is 200 when the destination accepted it, 502 otherwise.
 * - Forwarding (`X-Proxy-Mode: forward`, the web app's email forwarding,
 *   apps/web/lib/forwarding): the content type and the Standard Webhooks
 *   headers pass through, redirects are not followed, and the answer is
 *   always JSON: `{ status, body }` with the destination's status and the
 *   start of its body, or `{ error }` when it could not be reached.
 * - Relay (`X-Proxy-Mode: relay`, forwarding a captured HTTP request as
 *   received): the body is JSON `{ method, headers, body }` with the body in
 *   base64, and the request goes out with that method, those headers (minus
 *   hop-by-hop ones) and those exact bytes. Answers like forward mode, plus
 *   `durationMs`, the destination's own time.
 */

interface Env {
  NOTIFY_SECRET: string;
}

const BLOCKED_PORTS = new Set([22, 25, 53, 110, 143, 445, 3306, 5432, 6379]);

/** Headers a forwarded delivery keeps; everything else is dropped. */
const FORWARD_HEADERS = [
  "content-type",
  "user-agent",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
];
/**
 * Above the largest email JSON the web app can build (its text and HTML parts
 * are capped at 256 KB each and headers at 512 KB, but JSON escaping can
 * multiply them); the web app refuses anything larger before sending.
 */
const MAX_FORWARD_BODY = 10 * 1024 * 1024;
/** A relay envelope carries the body in base64 (4/3 of it) plus the headers. */
const MAX_RELAY_ENVELOPE = 15 * 1024 * 1024;
const RELAY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Never relayed: connection-level headers, and what fetch sets itself. */
const RELAY_DROPPED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);
const FORWARD_TIMEOUT_MS = 15_000;
const EXCERPT_BYTES = 1024;

function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  // HTTPS only
  if (parsed.protocol !== "https:") return true;

  // No IP literals — require real hostnames
  const host = parsed.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith("[") || host.includes(":")) return true;

  // Block localhost aliases
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;

  // Block dangerous ports
  if (parsed.port && BLOCKED_PORTS.has(Number(parsed.port))) return true;

  return false;
}

/** Compares in time that does not depend on where the strings differ. */
function sameSecret(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The first EXCERPT_BYTES of a response body, as text. */
async function excerpt(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < EXCERPT_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  if (size === 0) return null;
  const bytes = new Uint8Array(Math.min(size, EXCERPT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  // Postgres text cannot hold NUL, and the web app stores this excerpt.
  return new TextDecoder().decode(bytes).replaceAll("\u0000", "");
}

async function forward(request: Request, targetUrl: string): Promise<Response> {
  if (isBlockedUrl(targetUrl)) return json({ error: "The URL is not allowed." });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FORWARD_BODY) return json({ error: "The body is larger than 10 MB." });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FORWARD_BODY) return json({ error: "The body is larger than 10 MB." });

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    return json({ status: response.status, body: await excerpt(response) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return json({
      error: timedOut
        ? `No answer within ${FORWARD_TIMEOUT_MS / 1000} s.`
        : "The connection failed.",
    });
  }
}

interface RelayEnvelope {
  method: string;
  headers: [string, string][];
  body: string | null;
}

function parseRelayEnvelope(raw: string): RelayEnvelope | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { method, headers, body } = data as Record<string, unknown>;
  if (typeof method !== "string" || !RELAY_METHODS.has(method)) return null;
  if (!Array.isArray(headers)) return null;
  const pairs: [string, string][] = [];
  for (const pair of headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    ) {
      return null;
    }
    pairs.push([pair[0], pair[1]]);
  }
  if (body !== null && typeof body !== "string") return null;
  return { method, headers: pairs, body: body ?? null };
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function relay(request: Request, targetUrl: string): Promise<Response> {
  if (isBlockedUrl(targetUrl)) return json({ error: "The URL is not allowed." });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_RELAY_ENVELOPE) return json({ error: "The body is larger than 10 MB." });
  const raw = await request.text();
  if (raw.length > MAX_RELAY_ENVELOPE) return json({ error: "The body is larger than 10 MB." });
  const envelope = parseRelayEnvelope(raw);
  if (!envelope) return json({ error: "The relay request is malformed." });

  const body = envelope.body === null ? null : fromBase64(envelope.body);
  if (envelope.body !== null && !body) return json({ error: "The relay request is malformed." });
  if (body && body.byteLength > MAX_FORWARD_BODY) {
    return json({ error: "The body is larger than 10 MB." });
  }

  const headers = new Headers();
  for (const [name, value] of envelope.headers) {
    const lower = name.toLowerCase();
    if (RELAY_DROPPED_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("cf-")) {
      continue;
    }
    try {
      headers.append(name, value);
    } catch {
      // A name or value fetch refuses: leave it out rather than fail the delivery.
    }
  }

  const started = Date.now();
  try {
    const response = await fetch(targetUrl, {
      method: envelope.method,
      headers,
      body: envelope.method === "GET" || envelope.method === "HEAD" ? null : body,
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const durationMs = Date.now() - started;
    return json({ status: response.status, body: await excerpt(response), durationMs });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return json({
      error: timedOut
        ? `No answer within ${FORWARD_TIMEOUT_MS / 1000} s.`
        : "The connection failed.",
    });
  }
}

/**
 * Ensures the notification JSON body contains a top-level `text` field (required
 * by Slack incoming webhooks and Discord `/slack` endpoints) and `content` field
 * (for standard Discord webhooks) without disturbing any other properties.
 */
function formatNotificationPayload(raw: string): string {
  try {
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      if (!("text" in data) && ("slug" in data || "preview" in data)) {
        const slug = typeof data.slug === "string" && data.slug ? `*${data.slug}*` : "endpoint";
        const method = typeof data.method === "string" && data.method ? data.method : "POST";
        const path = typeof data.path === "string" ? data.path : "/";
        const safePreview =
          typeof data.preview === "string" && data.preview.length > 0
            ? `\n\`\`\`\n${data.preview.replaceAll("```", "'''")}\n\`\`\``
            : "";
        const formatted = `New webhook on ${slug} (\`${method} ${path}\`)${safePreview}`;
        data.text = formatted;
        if (!("content" in data)) {
          data.content = formatted;
        }
        return JSON.stringify(data);
      }
    }
  } catch {
    // Non-JSON, relay original
  }
  return raw;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Authenticate with shared secret
    if (!sameSecret(request.headers.get("X-Auth"), env.NOTIFY_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Read target URL from header
    const targetUrl = request.headers.get("X-Target-URL");
    if (!targetUrl) {
      return new Response("Missing X-Target-URL", { status: 400 });
    }

    if (request.headers.get("X-Proxy-Mode") === "forward") {
      return forward(request, targetUrl);
    }
    if (request.headers.get("X-Proxy-Mode") === "relay") {
      return relay(request, targetUrl);
    }

    if (isBlockedUrl(targetUrl)) {
      return new Response("Blocked target", { status: 403 });
    }

    // Read original body, ensure Slack/Discord compatibility, and read sender IP header
    const rawBody = await request.text();
    const body = formatNotificationPayload(rawBody);
    const senderIp = request.headers.get("X-Sender-IP");

    // Build forwarded headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "webhooks.cc-notify/1.0",
    };
    if (senderIp) {
      headers["X-Sender-IP"] = senderIp;
    }

    // Relay the POST
    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers,
        body,
      });
      return new Response("OK", { status: resp.ok ? 200 : 502 });
    } catch {
      return new Response("Relay failed", { status: 502 });
    }
  },
};
