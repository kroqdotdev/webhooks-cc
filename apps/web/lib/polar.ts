import { Polar } from "@polar-sh/sdk";
import { publicEnv } from "./env";

class PolarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarConfigError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new PolarConfigError(`${name} is not configured`);
  }
  return value;
}

export function createPolarClient(): Polar {
  const accessToken = requireEnv("POLAR_ACCESS_TOKEN");

  return new Polar({
    accessToken,
    server: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
  });
}

export function getPolarCheckoutConfig() {
  return {
    appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    proProductId: requireEnv("POLAR_PRO_PRODUCT_ID"),
  };
}

export function getPolarTeamsCheckoutConfig() {
  return {
    appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
    teamsProductId: requireEnv("POLAR_TEAMS_PRODUCT_ID"),
  };
}

export function getPolarWebhookSecret(): string {
  return requireEnv("POLAR_WEBHOOK_SECRET");
}

export function unwrapPolarResult<T>(
  result: T | { ok: true; value: T } | { ok: false; error: unknown },
  operation: string
): T {
  if (result && typeof result === "object" && "ok" in result && typeof result.ok === "boolean") {
    if (result.ok) {
      return result.value;
    }

    const error = result.error;
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : `Polar ${operation} failed`;

    throw new Error(message);
  }

  return result;
}

function truncateDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

function messagesFromValidationDetail(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null;

  const messages = detail
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { msg?: unknown }).msg : null
    )
    .filter((msg): msg is string => typeof msg === "string" && msg.length > 0);

  return messages.length > 0 ? truncateDetail(messages.join("; ")) : null;
}

/**
 * Extracts a short human-readable description from a Polar SDK error, or null
 * when there is nothing better than the generic message. Lets routes surface
 * validation detail (e.g. Polar rejecting an unroutable billing email) without
 * leaking raw response bodies. Duck-typed rather than instanceof so it also
 * covers errors re-wrapped by unwrapPolarResult.
 */
export function describePolarError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  // HTTPValidationError carries FastAPI-style detail entries: {loc, msg, type}.
  const fromDetail = messagesFromValidationDetail((error as { detail?: unknown }).detail);
  if (fromDetail) return fromDetail;

  // PolarError subclasses carry the raw response body; Polar 4xx bodies are
  // JSON like {"detail": "..."} or {"error": "...", "error_description": "..."}.
  const body = (error as { body?: unknown }).body;
  if (typeof body === "string" && body.length > 0) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.detail === "string" && parsed.detail.length > 0) {
        return truncateDetail(parsed.detail);
      }
      const fromBodyDetail = messagesFromValidationDetail(parsed.detail);
      if (fromBodyDetail) return fromBodyDetail;
      if (typeof parsed.error_description === "string" && parsed.error_description.length > 0) {
        return truncateDetail(parsed.error_description);
      }
    } catch {
      // Non-JSON body: not safe to surface.
    }
  }

  return null;
}

export { PolarConfigError };
