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

export function getPolarWebhookSecret(): string {
  return requireEnv("POLAR_WEBHOOK_SECRET");
}

export function unwrapPolarResult<T>(
  result: T | { ok: true; value: T } | { ok: false; error: unknown },
  operation: string
): T {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    typeof result.ok === "boolean"
  ) {
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

export { PolarConfigError };
