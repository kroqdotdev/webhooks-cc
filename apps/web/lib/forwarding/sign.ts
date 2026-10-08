import { createHmac, randomBytes } from "node:crypto";

/**
 * Standard Webhooks signing for forwarded email
 * (https://www.standardwebhooks.com): the receiving end verifies
 * `webhook-signature` with the endpoint's secret, as the SDK's
 * verifyStandardWebhookSignature does.
 */

export const FORWARD_USER_AGENT = "webhooks.cc (+https://webhooks.cc/docs/forwarding)";

/** A new signing secret: "whsec_" and 24 random bytes in base64. */
export function generateForwardSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
}

/** The same id for every copy of one email, so the receiving end can drop repeats. */
export function forwardMessageId(requestId: string): string {
  return `msg_${requestId.replace(/-/g, "")}`;
}

/** "v1," and the base64 HMAC-SHA256 of "id.timestamp.body". */
export function signForward(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${body}`);
  return `v1,${mac.digest("base64")}`;
}

/** The headers of one forwarded copy, signed at `now`. */
export function forwardHeaders(
  secret: string,
  requestId: string,
  body: string,
  now: Date = new Date()
): Record<string, string> {
  const id = forwardMessageId(requestId);
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    "content-type": "application/json",
    "user-agent": FORWARD_USER_AGENT,
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signForward(secret, id, timestamp, body),
  };
}
