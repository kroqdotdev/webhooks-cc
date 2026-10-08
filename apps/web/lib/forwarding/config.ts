import { serverEnv } from "@/lib/env";
import type { SendOptions } from "./send";

/** Sends that never get an answer give up after this long. */
export const FORWARD_TIMEOUT_MS = 15_000;

/** http and local addresses: only with FORWARDING_ALLOW_PRIVATE_TARGETS, never in production. */
export function allowPrivateTargets(): boolean {
  return serverEnv().FORWARDING_ALLOW_PRIVATE_TARGETS && process.env.NODE_ENV !== "production";
}

/** How forwarding sends from this process: the notify proxy, or direct with SSRF checks. */
export function sendOptions(): SendOptions {
  const env = serverEnv();
  return {
    timeoutMs: FORWARD_TIMEOUT_MS,
    proxy:
      env.NOTIFY_PROXY_URL && env.NOTIFY_SECRET
        ? { url: env.NOTIFY_PROXY_URL, secret: env.NOTIFY_SECRET }
        : null,
    allowPrivate: allowPrivateTargets(),
  };
}
