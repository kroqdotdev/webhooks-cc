/**
 * Cloudflare Worker: outbound notification proxy.
 *
 * The receiver POSTs here instead of directly to Slack/Discord/etc.
 * This worker relays the request so the destination sees a Cloudflare
 * edge IP instead of the origin server's real IP.
 */

interface Env {
  NOTIFY_SECRET: string;
}

const BLOCKED_PORTS = new Set([22, 25, 53, 110, 143, 445, 3306, 5432, 6379]);

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Authenticate with shared secret
    const auth = request.headers.get("X-Auth");
    if (!auth || auth !== env.NOTIFY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Read target URL from header
    const targetUrl = request.headers.get("X-Target-URL");
    if (!targetUrl) {
      return new Response("Missing X-Target-URL", { status: 400 });
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
