import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { PROXY_CONTROL_HEADERS } from "./proxy-headers";
import type { Outgoing } from "./relay";
import { checkForwardUrl, resolveForwardTarget } from "./target";

/**
 * Sends one delivery. Through the notify proxy (a Cloudflare Worker,
 * infra/notify-proxy) when one is configured, so the box's IP stays hidden,
 * as notifications do; otherwise directly, with the connection pinned to
 * addresses checked by target.ts. Redirects are never followed: only a 2xx
 * from the URL itself counts as delivered.
 *
 * A JSON forward (signed JSON, chat) uses the proxy's forward mode; a relay
 * (an HTTP request as received) its relay mode, which takes the method,
 * headers and base64 body as JSON.
 */

export interface SendResult {
  /** The response status, null when no response arrived. */
  status: number | null;
  durationMs: number;
  /** The start of the response body, for the dashboard. */
  excerpt: string | null;
  error: string | null;
  /** Seconds the destination asked us to wait (a 429's Retry-After), when it said. */
  retryAfterSeconds?: number | null;
}

export interface SendOptions {
  timeoutMs: number;
  proxy: { url: string; secret: string } | null;
  allowPrivate: boolean;
}

export const EXCERPT_BYTES = 1024;

export function isDelivered(result: SendResult): boolean {
  return (
    result.error === null && result.status !== null && result.status >= 200 && result.status < 300
  );
}

function excerptOf(bytes: Buffer): string | null {
  if (bytes.length === 0) return null;
  return bytes.subarray(0, EXCERPT_BYTES).toString("utf8").replaceAll("\u0000", "");
}

/** Retry-After as whole seconds: a number of seconds (rounded up) or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  // An HTTP date names a weekday and a month; never read a bare number as one.
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(Math.ceil((at - now) / 1000), 0) : null;
}

function describeError(error: unknown, timeoutMs: number): string {
  const err = error as { name?: string; code?: string; message?: string; cause?: unknown };
  const code = err.code ?? (err.cause as { code?: string } | undefined)?.code;
  if (err.name === "TimeoutError" || err.name === "AbortError" || err.message === "timeout") {
    return `No answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s.`;
  }
  switch (code) {
    case "ECONNREFUSED":
      return "The connection was refused.";
    case "ECONNRESET":
      return "The connection was reset.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The host name could not be resolved.";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "The host could not be reached.";
  }
  if (code && /^(CERT_|ERR_TLS|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
    return `TLS certificate problem (${code}).`;
  }
  return err.message ? err.message.slice(0, 300) : "The request failed.";
}

async function viaProxy(
  outgoing: Outgoing,
  options: SendOptions & { proxy: { url: string; secret: string } }
): Promise<Omit<SendResult, "durationMs"> & { durationMs?: number }> {
  if (!options.proxy.secret) {
    return {
      status: null,
      excerpt: null,
      error: "Forwarding is not configured on this server (NOTIFY_SECRET is missing).",
    };
  }
  const proxyHeaders: Record<string, string> = {};
  let body: string | null;
  if (outgoing.mode === "relay") {
    // The Worker sends this method, these headers and these bytes as they are.
    // The target goes inside the envelope, not in X-Target-URL, so a Worker
    // from before relay mode refuses the request instead of posting it on.
    proxyHeaders["content-type"] = "application/json";
    body = JSON.stringify({
      url: outgoing.url,
      method: outgoing.method,
      headers: outgoing.headers,
      body: outgoing.body ? outgoing.body.toString("base64") : null,
    });
  } else {
    // The Worker passes the content type and webhook headers through; the
    // proxy's own control headers can never come from here.
    for (const [name, value] of outgoing.headers) {
      if (!PROXY_CONTROL_HEADERS.has(name.toLowerCase())) proxyHeaders[name] = value;
    }
    // Forward mode carries JSON (signed JSON, chat), which is text.
    body = outgoing.body ? outgoing.body.toString("utf8") : null;
  }
  // Set last, so they always win.
  if (outgoing.mode !== "relay") proxyHeaders["x-target-url"] = outgoing.url;
  proxyHeaders["x-auth"] = options.proxy.secret;
  proxyHeaders["x-proxy-mode"] = outgoing.mode;
  const response = await fetch(options.proxy.url, {
    method: "POST",
    headers: proxyHeaders,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs + 5000),
  });
  const text = await response.text();
  if (response.status !== 200) {
    return {
      status: null,
      excerpt: null,
      error:
        outgoing.mode === "relay" && response.status === 400
          ? "The forwarding proxy does not support this delivery yet."
          : `The forwarding proxy answered ${response.status}.`,
    };
  }
  let result: {
    status?: number;
    body?: string | null;
    error?: string;
    durationMs?: number;
    retryAfter?: string | null;
  };
  try {
    result = JSON.parse(text);
  } catch {
    // An older proxy without this mode answers plain text.
    return {
      status: null,
      excerpt: null,
      error:
        outgoing.mode === "relay"
          ? "The forwarding proxy does not support forwarding requests as received yet."
          : "The forwarding proxy does not support forwarding yet.",
    };
  }
  if (result.error) return { status: null, excerpt: null, error: result.error.slice(0, 300) };
  return {
    status: result.status ?? null,
    excerpt: result.body || null,
    error: null,
    retryAfterSeconds: parseRetryAfter(result.retryAfter),
    // The destination's own time, measured by the Worker, when it says.
    ...(typeof result.durationMs === "number" && result.durationMs >= 0
      ? { durationMs: Math.round(result.durationMs) }
      : {}),
  };
}

async function direct(
  outgoing: Outgoing,
  options: SendOptions
): Promise<Omit<SendResult, "durationMs">> {
  const check = checkForwardUrl(outgoing.url, { allowPrivate: options.allowPrivate });
  if (!check.ok) return { status: null, excerpt: null, error: check.reason };
  const addresses = await resolveForwardTarget(check.url, { allowPrivate: options.allowPrivate });

  // Connect only to the addresses checked above, whatever a second lookup says.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const client = check.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    // An object, not raw pairs, so Node still sets Host; a repeated name
    // becomes a list.
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of outgoing.headers) {
      const existing = headers[name];
      headers[name] =
        existing === undefined
          ? value
          : Array.isArray(existing)
            ? [...existing, value]
            : [existing, value];
    }
    if (outgoing.body) headers["content-length"] = String(outgoing.body.byteLength);
    const request = client.request(
      check.url,
      {
        method: outgoing.method,
        headers,
        lookup: pinned,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const retryAfter = response.headers["retry-after"];
          resolve({
            status: response.statusCode ?? null,
            excerpt: excerptOf(Buffer.concat(chunks)),
            error: null,
            retryAfterSeconds: parseRetryAfter(
              Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
            ),
          });
        };
        response.on("data", (chunk: Buffer) => {
          if (size < EXCERPT_BYTES) {
            chunks.push(chunk);
            size += chunk.length;
          }
          // Nothing past the excerpt is needed.
          if (size >= EXCERPT_BYTES) response.destroy();
        });
        response.on("end", finish);
        response.on("close", finish);
        response.on("error", finish);
      }
    );
    const timer = setTimeout(() => request.destroy(new Error("timeout")), options.timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(outgoing.body ?? undefined);
  });
}

/**
 * A signed JSON or chat delivery: a POST with these headers and this body.
 * The proxy's forward mode passes only the content type and the Standard
 * Webhooks headers, so a delivery with the owner's own headers goes through
 * its relay mode, which sends every header.
 */
export function jsonForward(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: { ownerHeaders?: boolean } = {}
): Outgoing {
  return {
    method: "POST",
    url,
    headers: Object.entries(headers),
    body: Buffer.from(body, "utf8"),
    mode: options.ownerHeaders ? "relay" : "forward",
  };
}

export async function sendForward(outgoing: Outgoing, options: SendOptions): Promise<SendResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const result = options.proxy
      ? await viaProxy(outgoing, { ...options, proxy: options.proxy })
      : await direct(outgoing, options);
    // The Worker's own measure leaves out the hop to it.
    const { durationMs, ...rest } = result as typeof result & { durationMs?: number };
    return { ...rest, durationMs: durationMs ?? elapsed() };
  } catch (error) {
    return {
      status: null,
      excerpt: null,
      error: describeError(error, options.timeoutMs),
      durationMs: elapsed(),
    };
  }
}
