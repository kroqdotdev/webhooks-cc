import { publicEnv } from "@/lib/env";
import { buildQuotaExhaustedEmail } from "@/lib/email/quota-exhausted-email";
import { sendEmail } from "@/lib/email/mailer";
import { createAdminClient } from "@/lib/supabase/admin";

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Emails free users whose quota ran out. claim_quota_exhausted_users() takes
 * a 15-minute lease on each user it returns, so concurrent polls never email
 * the same user. Only a successful send starts the 7-day resend window
 * (mark_quota_email_sent); a failed send releases the lease so the next poll
 * retries, and a poll that dies mid-batch simply lets its leases expire.
 */
export async function sendQuotaExhaustedEmails(): Promise<{ sent: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_quota_exhausted_users", {
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(`claim_quota_exhausted_users failed: ${error.message}`);

  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  let sent = 0;
  let failed = 0;

  for (const user of data ?? []) {
    try {
      await sendEmail(
        buildQuotaExhaustedEmail({
          to: user.email,
          requestLimit: user.request_limit,
          periodEnd: new Date(user.period_end),
          teamBilledEndpoints: user.team_billed_endpoints,
          appUrl,
        })
      );
      sent++;
      const { error: markError } = await admin.rpc("mark_quota_email_sent", {
        p_user_id: user.id,
      });
      if (markError) console.error("[quota-emails] mark sent failed:", markError.message);
    } catch (sendError) {
      failed++;
      console.error("[quota-emails] send failed:", sendError);
      const { error: releaseError } = await admin
        .from("users")
        .update({ quota_email_claimed_at: null })
        .eq("id", user.id);
      if (releaseError) console.error("[quota-emails] lease release failed:", releaseError.message);
    }
  }

  return { sent, failed };
}

const globalForPoller = globalThis as unknown as { __quotaEmailPoller?: NodeJS.Timeout };

/** Starts the poll loop once per process. Called from instrumentation.ts. */
export function startQuotaEmailPoller(): void {
  if (globalForPoller.__quotaEmailPoller) return;

  const tick = async () => {
    try {
      const { sent, failed } = await sendQuotaExhaustedEmails();
      if (sent || failed) console.info(`[quota-emails] sent=${sent} failed=${failed}`);
    } catch (error) {
      console.error("[quota-emails] poll failed:", error);
    }
  };

  globalForPoller.__quotaEmailPoller = setInterval(tick, POLL_INTERVAL_MS);
  globalForPoller.__quotaEmailPoller.unref();
  void tick();
}
