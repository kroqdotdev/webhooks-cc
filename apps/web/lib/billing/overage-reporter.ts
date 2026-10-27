import { OVERAGE_EVENT_NAME } from "@/lib/capacity";
import { createPolarClient, getCapacityProductIds, loggablePolarError } from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
const LEASE_SECONDS = 120;

export interface OverageReport {
  account_kind: "user" | "team";
  account_id: string;
  polar_customer_id: string;
  from_total: number;
  to_total: number;
}

/**
 * The meter event for one report. The external id names the range of the
 * account's overage count it covers, so a resend after a crash or a lost
 * response is the same event, which Polar drops as a duplicate.
 */
export function overageEvent(report: OverageReport) {
  return {
    name: OVERAGE_EVENT_NAME,
    customer_id: report.polar_customer_id,
    external_id: `overage:${report.account_kind}:${report.account_id}:${report.from_total}-${report.to_total}`,
    metadata: { requests: report.to_total - report.from_total },
  };
}

/** A 4xx other than 429: sending the same event again cannot succeed. */
function isPermanentRefusal(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/**
 * Sends Polar the overage counted since the last report, for every account
 * that has some. claim_overage_reports() leases each account and fixes the
 * range; only a confirmed send moves overage_reported, so a failure is
 * retried with the same range once the lease runs out.
 */
export async function reportOverage(): Promise<{ sent: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_overage_reports", {
    p_limit: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_overage_reports failed: ${error.message}`);

  const reports = (data ?? []).filter((report) => report.to_total > report.from_total);
  if (reports.length === 0) return { sent: 0, failed: 0 };

  const polar = createPolarClient();
  let accepted: OverageReport[] = reports;
  try {
    await polar.events.ingest({ events: reports.map(overageEvent) });
  } catch {
    // One bad event (a customer gone from Polar, say) fails the whole batch;
    // send them one by one so it cannot hold up everyone else.
    accepted = [];
    for (const report of reports) {
      try {
        await polar.events.ingest({ events: [overageEvent(report)] });
        accepted.push(report);
      } catch (ingestError) {
        reportError("[overage] meter event was not accepted", loggablePolarError(ingestError), {
          accountKind: report.account_kind,
          accountId: report.account_id,
        });
        // Refused for good (the customer is gone from Polar, say): resending
        // would fail every lease forever, so the range is set aside. The
        // error above is the record for a person.
        if (isPermanentRefusal(ingestError)) {
          await admin.rpc("complete_overage_report", {
            p_account_kind: report.account_kind,
            p_account_id: report.account_id,
            p_to_total: report.to_total,
          });
        }
      }
    }
  }

  let sent = 0;
  let failed = reports.length - accepted.length;
  for (const report of accepted) {
    const { error: completeError } = await admin.rpc("complete_overage_report", {
      p_account_kind: report.account_kind,
      p_account_id: report.account_id,
      p_to_total: report.to_total,
    });
    if (completeError) {
      // Polar has the event; the lease expires and the same range is sent
      // again, which Polar drops.
      failed++;
      reportError("[overage] report not confirmed", completeError.message);
    } else {
      sent++;
    }
  }
  return { sent, failed };
}

const globalForReporter = globalThis as unknown as { __overageReporter?: NodeJS.Timeout };

/** Starts the report loop once per process, when the add-ons are configured. Called from instrumentation.ts. */
export function startOverageReporter(): void {
  if (globalForReporter.__overageReporter || !getCapacityProductIds()) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sent, failed } = await reportOverage();
      if (sent || failed) console.info(`[overage] reported=${sent} failed=${failed}`);
    } catch (error) {
      reportError("[overage] report poll failed", error);
    } finally {
      running = false;
    }
  };

  globalForReporter.__overageReporter = setInterval(() => void tick(), POLL_INTERVAL_MS);
  globalForReporter.__overageReporter.unref();
  void tick();
}
