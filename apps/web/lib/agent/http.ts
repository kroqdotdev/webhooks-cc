import { publicEnv, serverEnv } from "@/lib/env";
import { sandboxPoolUsage } from "./registrations";
import { assertionSigningConfigured } from "./assertion";
import { adaptiveDifficulty, issueChallenge, type PowChallenge } from "./pow";
import { AgentError } from "./errors";

/** Agent request bodies are small: an assertion, a few fields, 32 nonces. */
export const MAX_AGENT_BODY_BYTES = 16 * 1024;

/**
 * Reads the body, stopping as soon as it passes `max` bytes, whatever the
 * Content-Length says (a chunked body has none). Null when it is longer or
 * cannot be read.
 */
export async function readBoundedBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Reads a JSON object or (for the OAuth endpoints) a form-encoded body,
 * bounded in size. Returns null when the body is missing, too large, or not
 * an object; callers answer invalid_request.
 */
export async function readAgentBody(
  request: Request,
  options: { form?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  const body = await readBoundedBody(request, MAX_AGENT_BODY_BYTES);
  if (!body || body.byteLength === 0) return null;
  const text = new TextDecoder().decode(body);

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (options.form && contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function issuer(): string {
  return publicEnv().NEXT_PUBLIC_APP_URL;
}

export function challengeEndpointUrl(): string {
  return `${issuer()}/api/agent/identity/challenge`;
}

let warnedUnconfigured = false;

/**
 * Refuses anonymous registration when it is switched off or not configured
 * (no assertion signing key, no proof-of-work secret).
 */
export async function anonymousRegistrationUnavailable(): Promise<AgentError | null> {
  const env = serverEnv();
  if (!env.AGENT_ANONYMOUS_ENABLED) {
    return new AgentError(
      400,
      "anonymous_not_enabled",
      "Anonymous registration is turned off. Ask a human to sign up at webhooks.cc."
    );
  }
  if (!env.AGENT_POW_SECRET || !(await assertionSigningConfigured())) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(
        "[agent] anonymous registration needs AGENT_ASSERTION_SIGNING_KEY and AGENT_POW_SECRET"
      );
    }
    return new AgentError(
      503,
      "temporarily_unavailable",
      "Agent registration is not available right now. Retry later.",
      {},
      { "Retry-After": "600" }
    );
  }
  return null;
}

export function powSecrets(): string[] {
  const env = serverEnv();
  return [env.AGENT_POW_SECRET, env.AGENT_POW_SECRET_PREVIOUS].filter((secret): secret is string =>
    Boolean(secret)
  );
}

/** A fresh challenge, harder while the sandbox pool fills up. */
export async function newRegistrationChallenge(): Promise<PowChallenge> {
  const env = serverEnv();
  const difficulty = adaptiveDifficulty(
    env.AGENT_POW_DIFFICULTY,
    env.AGENT_POW_COUNT,
    await sandboxPoolUsage(),
    env.AGENT_SANDBOX_MAX_ENDPOINTS
  );
  return issueChallenge({
    secret: powSecrets()[0],
    audience: issuer(),
    difficulty,
    count: env.AGENT_POW_COUNT,
  });
}
