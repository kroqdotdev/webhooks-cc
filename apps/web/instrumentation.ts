import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("source-map-support/register");

    // Errors and log lines to StatOSS when STATOSS_DSN is set.
    const { startObservability } = await import("./lib/observability-start");
    startObservability();

    // Pre-connect Redis so the first rate-limited request doesn't fall back to in-memory
    const { waitForRedis } = await import("./lib/redis");
    await waitForRedis();

    // Email free users whose quota ran out; opt-in, see QUOTA_EMAILS_ENABLED.
    const { serverEnv } = await import("./lib/env");
    if (serverEnv().QUOTA_EMAILS_ENABLED) {
      const { startQuotaEmailPoller } = await import("./lib/quota-emails");
      startQuotaEmailPoller();
    }

    // Send forwarded email (lib/forwarding/worker.ts); see EMAIL_FORWARDING_WORKER.
    if (serverEnv().EMAIL_FORWARDING_WORKER) {
      const { startForwardingWorker } = await import("./lib/forwarding/worker");
      startForwardingWorker();
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportRequestError } = await import("./lib/observability");
    reportRequestError(error, request, context);
  }
};
