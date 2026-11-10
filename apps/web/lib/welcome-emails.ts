import { buildWelcomeEmail } from "@/lib/email/welcome-email";
import { sendEmail } from "@/lib/email/mailer";
import { parseSite, twoSites } from "@/lib/site";
import { homeOrigin } from "@/lib/supabase/home-site";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Sends each new account one getting-started email (migration 00093).
 * claim_welcome_email_users() returns accounts between 30 minutes and 7 days
 * old with a confirmed email that were never sent one, and takes a 15-minute
 * lease on each. Each account is then recorded as sent before the send
 * (mark_welcome_email_sent answers true only for the first caller), so the
 * email goes out at most once: a database error after the send, a slow batch
 * whose lease ran out, or a second web process can never repeat it. A send
 * that fails is reported and not retried. Accounts that existed before the
 * migration are marked as handled by it and are never claimed.
 */
export async function sendWelcomeEmails(): Promise<{ sent: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_welcome_email_users", {
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(`claim_welcome_email_users failed: ${error.message}`);

  let sent = 0;
  let failed = 0;

  for (const user of data ?? []) {
    // Only the process whose mark moves the row from unsent to sent goes on
    // to send, so two pollers can never both email one account.
    const { data: marked, error: markError } = await admin.rpc("mark_welcome_email_sent", {
      p_user_id: user.id,
    });
    if (markError) {
      failed++;
      reportError("[welcome-emails] mark sent failed", markError.message);
      continue;
    }
    if (!marked) continue;

    try {
      await sendEmail(
        buildWelcomeEmail({
          to: user.email,
          // With one site every link leads to webhooks.cc, so the copy does too.
          site: twoSites() ? parseSite(user.home_site) : "webhooks",
          appUrl: homeOrigin(user.home_site),
        })
      );
      sent++;
    } catch (sendError) {
      // Not retried: the transport cannot say whether the server took the
      // message before the error, and a missing welcome beats a second one.
      failed++;
      reportError("[welcome-emails] send failed", sendError);
    }
  }

  return { sent, failed };
}

const globalForPoller = globalThis as unknown as { __welcomeEmailPoller?: NodeJS.Timeout };

/** Starts the poll loop once per process. Called from instrumentation.ts. */
export function startWelcomeEmailPoller(): void {
  if (globalForPoller.__welcomeEmailPoller) return;

  // A slow mail server can make a batch outlast the interval; skip a tick
  // rather than run two batches at once.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sent, failed } = await sendWelcomeEmails();
      if (sent || failed) console.info(`[welcome-emails] sent=${sent} failed=${failed}`);
    } catch (error) {
      reportError("[welcome-emails] poll failed", error);
    } finally {
      running = false;
    }
  };

  globalForPoller.__welcomeEmailPoller = setInterval(tick, POLL_INTERVAL_MS);
  globalForPoller.__welcomeEmailPoller.unref();
  void tick();
}
