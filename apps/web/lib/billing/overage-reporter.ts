import { OVERAGE_EVENT_NAME, PAGE_OVERAGE_EVENT_NAME } from "@/lib/capacity";
import {
  createPolarClient,
  getCapacityProductIds,
  getPageProductIds,
  loggablePolarError,
} from "@/lib/polar";
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

/** Request overage, or parsed-page overage (migration 00070): the same loop, its own counters and meter. */
export type OverageResource = "requests" | "pages";

const SOURCES = {
  requests: {
    claim: "claim_overage_reports",
    complete: "complete_overage_report",
    event: OVERAGE_EVENT_NAME,
    prefix: "overage",
  },
  pages: {
    claim: "claim_page_overage_reports",
    complete: "complete_page_overage_report",
    event: PAGE_OVERAGE_EVENT_NAME,
    prefix: "page-overage",
  },
} as const;

/**
 * The meter event for one report. The external id names the range of the
 * account's overage count it covers, so a resend after a crash or a lost
 * response is the same event, which Polar drops as a duplicate.
 */
export function overageEvent(report: OverageReport, resource: OverageResource = "requests") {
  const source = SOURCES[resource];
  const amount = report.to_total - report.from_total;
  return {
    name: source.event,
    customer_id: report.polar_customer_id,
    external_id: `${source.prefix}:${report.account_kind}:${report.account_id}:${report.from_total}-${report.to_total}`,
    metadata: resource === "pages" ? { pages: amount } : { requests: amount },
  };
}

/**
 * Polar refused this one event (an unknown customer, an invalid payload), so
 * sending it again cannot succeed. Auth, timeout and conflict answers (401,
 * 403, 408, 409, say from a rotated token) say nothing about the event and
 * stay retryable, so no billable overage is set aside for them.
 */
function isPermanentRefusal(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 422;
}

/**
 * Sends Polar the overage counted since the last report, for every account
 * that has some. claim_overage_reports() leases each account and fixes the
 * range; only a confirmed send moves overage_reported, so a failure is
 * retried with the same range once the lease runs out.
 */
export async function reportOverage(
  resource: OverageResource = "requests"
): Promise<{ sent: number; failed: number }> {
  const source = SOURCES[resource];
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(source.claim, {
    p_limit: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`${source.claim} failed: ${error.message}`);

  const reports = (data ?? []).filter((report) => report.to_total > report.from_total);
  if (reports.length === 0) return { sent: 0, failed: 0 };

  const polar = createPolarClient();
  let accepted: OverageReport[] = reports;
  try {
    await polar.events.ingest({ events: reports.map((report) => overageEvent(report, resource)) });
  } catch {
    // One bad event (a customer gone from Polar, say) fails the whole batch;
    // send them one by one so it cannot hold up everyone else.
    accepted = [];
    for (const report of reports) {
      try {
        await polar.events.ingest({ events: [overageEvent(report, resource)] });
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
          await admin.rpc(source.complete, {
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
    const { error: completeError } = await admin.rpc(source.complete, {
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

/**
 * Starts the report loop once per process, for request overage and parsed-page
 * overage when their add-ons are configured. Called from instrumentation.ts.
 */
export function startOverageReporter(): void {
  const resources: OverageResource[] = [
    ...(getCapacityProductIds() ? (["requests"] as const) : []),
    ...(getPageProductIds() ? (["pages"] as const) : []),
  ];
  if (globalForReporter.__overageReporter || resources.length === 0) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const resource of resources) {
        const { sent, failed } = await reportOverage(resource);
        if (sent || failed) {
          console.info(`[overage] ${resource} reported=${sent} failed=${failed}`);
        }
      }
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
