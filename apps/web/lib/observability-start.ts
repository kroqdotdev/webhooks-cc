import { format } from "node:util";
import * as StatOSS from "@statoss/sdk";
import { APP_VERSION } from "./changelog";
import { redactEmails, redactEvent } from "./observability-redact";

/**
 * Starts the StatOSS client for the Node server (`instrumentation.ts`), when
 * STATOSS_DSN is set. Errors are reported through `lib/observability.ts`.
 *
 * Log lines: `console.error`, `warn` and `info` also go to StatOSS's logs
 * (worker summaries, Next's own error output). Not `console.log`, which only
 * the dev email transport and Next's banner use, and not the `[audit]` lines,
 * which `audit_events` keeps and whose metadata can hold an invited address.
 * At most LINES_PER_MINUTE lines a minute go out; the console itself always
 * gets every line.
 *
 * Email addresses are replaced with `[email]` in every line and event sent
 * (`observability-redact.ts`).
 */

const LINES_PER_MINUTE = 600;
const LEVELS = ["error", "warn", "info"] as const;

export function startObservability(): boolean {
  const dsn = process.env.STATOSS_DSN?.trim();
  if (!dsn) return false;
  const sha = process.env.GIT_SHA?.trim();
  StatOSS.init({
    dsn,
    environment: process.env.STATOSS_ENVIRONMENT?.trim() || process.env.NODE_ENV,
    release: `webhooks-web@${APP_VERSION}${sha ? `+${sha.slice(0, 12)}` : ""}`,
    logs: true,
    beforeSend: (event) => redactEvent(event),
    // Fetch breadcrumbs would carry forwarding destinations, and a chat
    // webhook URL holds its secret in the path.
    integrations: { fetch: false },
  });
  bridgeConsole();
  return true;
}

function bridgeConsole(): void {
  let windowStart = Date.now();
  let sent = 0;
  let held = 0;
  let inside = false;
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (inside) return;
      inside = true;
      try {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          if (held > 0) StatOSS.logger.warn(`${held} log lines were kept from StatOSS last minute`);
          windowStart = now;
          sent = 0;
          held = 0;
        }
        const line = format(...args);
        if (level === "info" && line.startsWith("[audit] ")) {
          // Kept in audit_events; see above.
        } else if (sent < LINES_PER_MINUTE) {
          sent++;
          StatOSS.logger[level](redactEmails(line));
        } else {
          held++;
        }
      } catch {
        // Logging must never throw into the caller.
      } finally {
        inside = false;
      }
    };
  }
}
