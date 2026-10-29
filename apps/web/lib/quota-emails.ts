import { homeOrigin } from "@/lib/supabase/home-site";
import { buildQuotaExhaustedEmail } from "@/lib/email/quota-exhausted-email";
import { sendEmail } from "@/lib/email/mailer";
import { getCapacityProductIds } from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";
import { getQuotaRejections, type QuotaRejections } from "@/lib/supabase/quota-rejections";
import { reportError } from "@/lib/observability";

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * Emails users whose quota ran out, free and paid alike (a paid account once
 * it is also past its one-time blocks and overage). claim_quota_exhausted_users()
 * takes a 15-minute lease on each user it returns, so concurrent polls never
 * email the same user. Only a successful send starts the resend window
 * (mark_quota_email_sent): a week for a free account, the rest of the billing
 * period for a paid one. A failed send releases the lease so the next poll
 * retries, and a poll that dies mid-batch simply lets its leases expire. Each
 * email names this period's rejected webhooks per endpoint when there are any
 * yet; the poll runs every 10 minutes, so a user claimed just after hitting
 * the limit usually has none and gets the generic copy.
 */
export async function sendQuotaExhaustedEmails(): Promise<{ sent: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_quota_exhausted_users", {
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(`claim_quota_exhausted_users failed: ${error.message}`);

  const extraRequestsOffered = getCapacityProductIds() !== null;
  // Each account's site, where its links lead (sessions are per host). The
  // links fall back to webhooks.cc when it cannot be read.
  const users = data ?? [];
  const siteOf = new Map<string, string>();
  try {
    if (users.length > 0) {
      const { data: sites, error: sitesError } = await admin
        .from("users")
        .select("id, home_site")
        .in(
          "id",
          users.map((user: { id: string }) => user.id)
        );
      if (sitesError) throw sitesError;
      for (const row of (sites ?? []) as { id: string; home_site: string }[]) {
        siteOf.set(row.id, row.home_site);
      }
    }
  } catch (sitesError) {
    reportError("[quota-emails] account sites could not be read", sitesError);
  }
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    // The counts are extra detail: if they cannot be read, the generic email
    // still goes out rather than the user hearing nothing.
    let rejections: QuotaRejections | null = null;
    try {
      rejections = await getQuotaRejections(user.id);
    } catch (rejectionsError) {
      reportError("[quota-emails] rejection counts failed", rejectionsError);
    }

    try {
      await sendEmail(
        buildQuotaExhaustedEmail({
          to: user.email,
          // A database without migration 00077 returns free users only, and
          // none of these columns.
          requestLimit: user.request_limit + (user.block_requests ?? 0),
          periodEnd: new Date(user.period_end),
          teamBilledEndpoints: user.team_billed_endpoints,
          rejections,
          plan: user.plan ?? "free",
          planEnding: user.cancel_at_period_end ?? false,
          overageActive: user.overage_active ?? false,
          extraRequestsOffered,
          appUrl: homeOrigin(siteOf.get(user.id)),
        })
      );
      sent++;
      const { error: markError } = await admin.rpc("mark_quota_email_sent", {
        p_user_id: user.id,
      });
      if (markError) reportError("[quota-emails] mark sent failed", markError.message);
    } catch (sendError) {
      failed++;
      reportError("[quota-emails] send failed", sendError);
      const { error: releaseError } = await admin
        .from("users")
        .update({ quota_email_claimed_at: null })
        .eq("id", user.id);
      if (releaseError) reportError("[quota-emails] lease release failed", releaseError.message);
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
      reportError("[quota-emails] poll failed", error);
    }
  };

  globalForPoller.__quotaEmailPoller = setInterval(tick, POLL_INTERVAL_MS);
  globalForPoller.__quotaEmailPoller.unref();
  void tick();
}
