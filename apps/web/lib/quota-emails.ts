import { publicEnv } from "@/lib/env";
import { buildQuotaExhaustedEmail } from "@/lib/email/quota-exhausted-email";
import { sendEmail } from "@/lib/email/mailer";
import { createAdminClient } from "@/lib/supabase/admin";

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Emails free users whose quota ran out. claim_quota_exhausted_users()
 * stamps each user before returning it, so a user is never emailed twice for
 * one claim even with several web processes polling. A failed send clears the
 * stamp so the next poll retries it.
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
          appUrl,
        })
      );
      sent++;
    } catch (sendError) {
      failed++;
      console.error("[quota-emails] send failed:", sendError);
      const { error: resetError } = await admin
        .from("users")
        .update({ quota_email_sent_at: null })
        .eq("id", user.id);
      if (resetError) console.error("[quota-emails] stamp reset failed:", resetError.message);
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
