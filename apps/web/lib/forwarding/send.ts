import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { checkForwardUrl, resolveForwardTarget } from "./target";

/**
 * Sends one forwarded email. Through the notify proxy (a Cloudflare Worker,
 * infra/notify-proxy) when one is configured, so the box's IP stays hidden,
 * as notifications do; otherwise directly, with the connection pinned to
 * addresses checked by target.ts. Redirects are never followed: only a 2xx
 * from the URL itself counts as delivered.
 */

export interface SendResult {
  /** The response status, null when no response arrived. */
  status: number | null;
  durationMs: number;
  /** The start of the response body, for the dashboard. */
  excerpt: string | null;
  error: string | null;
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
  target: string,
  headers: Record<string, string>,
  body: string,
  options: SendOptions & { proxy: { url: string; secret: string } }
): Promise<Omit<SendResult, "durationMs">> {
  const response = await fetch(options.proxy.url, {
    method: "POST",
    headers: {
      ...headers,
      "x-target-url": target,
      "x-auth": options.proxy.secret,
      // The Worker passes the webhook headers through and answers with the
      // destination's status and body start as JSON.
      "x-proxy-mode": "forward",
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs + 5000),
  });
  const text = await response.text();
  if (response.status !== 200) {
    return {
      status: null,
      excerpt: null,
      error: `The forwarding proxy answered ${response.status}.`,
    };
  }
  let result: { status?: number; body?: string | null; error?: string };
  try {
    result = JSON.parse(text);
  } catch {
    // An older proxy without the forward mode answers plain text.
    return {
      status: null,
      excerpt: null,
      error: "The forwarding proxy does not support forwarding yet.",
    };
  }
  if (result.error) return { status: null, excerpt: null, error: result.error.slice(0, 300) };
  return { status: result.status ?? null, excerpt: result.body || null, error: null };
}

async function direct(
  target: string,
  headers: Record<string, string>,
  body: string,
  options: SendOptions
): Promise<Omit<SendResult, "durationMs">> {
  const check = checkForwardUrl(target, { allowPrivate: options.allowPrivate });
  if (!check.ok) return { status: null, excerpt: null, error: check.reason };
  const addresses = await resolveForwardTarget(check.url, { allowPrivate: options.allowPrivate });

  // Connect only to the addresses checked above, whatever a second lookup says.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const client = check.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      check.url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
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
          resolve({
            status: response.statusCode ?? null,
            excerpt: excerptOf(Buffer.concat(chunks)),
            error: null,
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
    request.end(body);
  });
}

export async function sendForward(
  target: string,
  headers: Record<string, string>,
  body: string,
  options: SendOptions
): Promise<SendResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const result = options.proxy
      ? await viaProxy(target, headers, body, { ...options, proxy: options.proxy })
      : await direct(target, headers, body, options);
    return { ...result, durationMs: elapsed() };
  } catch (error) {
    return {
      status: null,
      excerpt: null,
      error: describeError(error, options.timeoutMs),
      durationMs: elapsed(),
    };
  }
}
