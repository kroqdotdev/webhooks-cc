import { serverEnv } from "@/lib/env";
import type { SendOptions } from "./send";

/** Sends that never get an answer give up after this long. */
export const FORWARD_TIMEOUT_MS = 15_000;

/** http and local addresses: only with FORWARDING_ALLOW_PRIVATE_TARGETS, never in production. */
export function allowPrivateTargets(): boolean {
  return serverEnv().FORWARDING_ALLOW_PRIVATE_TARGETS && process.env.NODE_ENV !== "production";
}

/**
 * How forwarding sends from this process: the notify proxy when
 * NOTIFY_PROXY_URL is set, direct with SSRF checks otherwise. A proxy URL
 * without its secret is a configuration error (send.ts fails such
 * deliveries), never a reason to send directly and show the box's IP.
 */
export function sendOptions(): SendOptions {
  const env = serverEnv();
  return {
    timeoutMs: FORWARD_TIMEOUT_MS,
    proxy: env.NOTIFY_PROXY_URL
      ? { url: env.NOTIFY_PROXY_URL, secret: env.NOTIFY_SECRET ?? "" }
      : null,
    allowPrivate: allowPrivateTargets(),
  };
}
