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

    if (isBlockedUrl(targetUrl)) {
      return new Response("Blocked target", { status: 403 });
    }

    // Read original body and sender IP header
    const body = await request.text();
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
