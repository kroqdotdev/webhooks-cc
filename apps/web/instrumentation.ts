import * as Sentry from "@sentry/nextjs";

export function onRequestError(
  ...args: Parameters<typeof Sentry.captureRequestError>
) {
  Sentry.captureRequestError(...args);
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
