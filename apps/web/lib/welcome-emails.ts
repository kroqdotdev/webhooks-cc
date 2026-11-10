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
 * lease on each, so concurrent polls never email the same account. Only a
 * successful send is recorded (mark_welcome_email_sent). A failed send
 * releases the lease so the next poll retries, and a poll that dies mid-batch
 * simply lets its leases expire. Accounts that existed before the migration
 * are marked as handled by it and are never claimed.
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
      const { error: markError } = await admin.rpc("mark_welcome_email_sent", {
        p_user_id: user.id,
      });
      if (markError) reportError("[welcome-emails] mark sent failed", markError.message);
    } catch (sendError) {
      failed++;
      reportError("[welcome-emails] send failed", sendError);
      const { error: releaseError } = await admin
        .from("users")
        .update({ welcome_email_claimed_at: null })
        .eq("id", user.id);
      if (releaseError) reportError("[welcome-emails] lease release failed", releaseError.message);
    }
  }

  return { sent, failed };
}

const globalForPoller = globalThis as unknown as { __welcomeEmailPoller?: NodeJS.Timeout };

/** Starts the poll loop once per process. Called from instrumentation.ts. */
export function startWelcomeEmailPoller(): void {
  if (globalForPoller.__welcomeEmailPoller) return;

  const tick = async () => {
    try {
      const { sent, failed } = await sendWelcomeEmails();
      if (sent || failed) console.info(`[welcome-emails] sent=${sent} failed=${failed}`);
    } catch (error) {
      reportError("[welcome-emails] poll failed", error);
    }
  };

  globalForPoller.__welcomeEmailPoller = setInterval(tick, POLL_INTERVAL_MS);
  globalForPoller.__welcomeEmailPoller.unref();
  void tick();
}
