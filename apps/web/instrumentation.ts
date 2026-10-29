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

    // Parse emails for endpoints with layouts (lib/parsing/worker.ts); off with
    // PARSE_WORKER=false. Deliveries of those emails wait for their parse.
    if (process.env.PARSE_WORKER !== "false" && process.env.PARSE_WORKER !== "0") {
      const { startParseWorker } = await import("./lib/parsing/worker");
      startParseWorker();
    }

    // Open and resolve endpoint alerts and send their notices (lib/alerts);
    // off with ALERTS_WORKER=false, like the forwarding worker.
    if (process.env.ALERTS_WORKER !== "false" && process.env.ALERTS_WORKER !== "0") {
      const { startAlertChecker } = await import("./lib/alerts/checker");
      startAlertChecker();
    }

    // Delete the stored objects of deleted requests (lib/storage/deleter.ts);
    // starts only when object storage is configured.
    const { startStorageDeleter } = await import("./lib/storage/deleter");
    startStorageDeleter();

    // Send counted overage to Polar's meter (lib/billing/overage-reporter.ts);
    // starts only when the extra-request products are configured.
    const { startOverageReporter } = await import("./lib/billing/overage-reporter");
    startOverageReporter();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportRequestError } = await import("./lib/observability");
    reportRequestError(error, request, context);
  }
};
