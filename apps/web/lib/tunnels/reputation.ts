import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { tunnelConfig } from "./config";
import { tellStaffOfReport } from "./reports";

/*
 * The preview domain's reputation, checked once a day with Google Web Risk
 * (the commercial Safe Browsing; its free tier covers a call a day). Every
 * paying customer's previews live on that one domain, so a listing must reach
 * us, not them: a hit opens a report (source "reputation") for staff and
 * sends one error to StatOSS. Runs only with WEB_RISK_API_KEY. The last
 * result is kept in memory for the operations center; one web process serves
 * production, and a restart checks again.
 */

const ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";
const THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"] as const;
const DAY_MS = 86_400_000;
/** The first check waits for the server to settle. */
const FIRST_DELAY_MS = 60_000;

export interface ReputationResult {
  checkedAt: string;
  uri: string;
  /** Web Risk's threat types for the URI; empty when it is clean. */
  threats: string[];
  /** Why the check could not run, when it could not. */
  error: string | null;
  /** The report a hit opened, when it opened one. */
  reportId: string | null;
}

const store = globalThis as typeof globalThis & {
  __tunnelReputation?: ReputationResult | null;
  __tunnelReputationTimer?: ReturnType<typeof setInterval>;
};

/** The last check's result in this process, or null before the first. */
export function lastReputation(): ReputationResult | null {
  return store.__tunnelReputation ?? null;
}

export function reputationConfigured(): boolean {
  return Boolean(serverEnv().WEB_RISK_API_KEY && tunnelConfig());
}

/** The URI checked: the preview domain's apex. */
export function reputationUri(): string | null {
  const config = tunnelConfig();
  return config ? `${config.previewOrigin.protocol}//${config.previewOrigin.host}/` : null;
}

/** abuse_reports.kind for Web Risk's threat types. */
function kindFor(threats: string[]): "phishing" | "malware" {
  return threats.includes("SOCIAL_ENGINEERING") ? "phishing" : "malware";
}

/**
 * Asks Web Risk about the preview domain once, records the result, and opens a
 * report on a hit unless one from this check is still open. Never throws.
 */
export async function checkReputation(
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<ReputationResult | null> {
  const key = serverEnv().WEB_RISK_API_KEY;
  const uri = reputationUri();
  if (!key || !uri) return null;
  const result: ReputationResult = {
    checkedAt: new Date(now).toISOString(),
    uri,
    threats: [],
    error: null,
    reportId: null,
  };
  try {
    const params = new URLSearchParams({ uri, key });
    for (const type of THREAT_TYPES) params.append("threatTypes", type);
    const answer = await fetcher(`${ENDPOINT}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!answer.ok) {
      result.error = `Web Risk answered ${answer.status}`;
    } else {
      const body = (await answer.json()) as { threat?: { threatTypes?: string[] } };
      result.threats = (body.threat?.threatTypes ?? []).filter((t) => typeof t === "string");
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  if (result.error) {
    console.warn(`[tunnels] reputation check failed: ${result.error}`);
  } else if (result.threats.length > 0) {
    try {
      result.reportId = await openReputationReport(uri, result.threats);
    } catch (error) {
      reportError("[tunnels] reputation report not saved", error);
    }
  }
  store.__tunnelReputation = result;
  return result;
}

/** Opens a report for a listing, unless one from this check is open. Its id, or null. */
async function openReputationReport(uri: string, threats: string[]): Promise<string | null> {
  const admin = createAdminClient();
  const { data: open, error } = await admin
    .from("abuse_reports")
    .select("id")
    .eq("source", "reputation")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (open) return null;
  const { data: row, error: insertError } = await admin
    .from("abuse_reports")
    .insert({
      source: "reputation",
      kind: kindFor(threats),
      url: uri,
      details:
        `Google Web Risk lists ${uri} as ${threats.join(", ")}. Find the preview behind it ` +
        `(phishing flags and reports), take it down, then ask Google for a review in Search Console.`,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  reportError(
    "[tunnels] the preview domain is on Google Web Risk",
    new Error(`Listed as ${threats.join(", ")}`)
  );
  await tellStaffOfReport(row.id, "reputation");
  return row.id;
}

/** Checks once a day from the web app's start (instrumentation.ts), when a key is set. */
export function startReputationChecker(): void {
  if (store.__tunnelReputationTimer || !reputationConfigured()) return;
  const tick = () => void checkReputation();
  const first = setTimeout(tick, FIRST_DELAY_MS);
  first.unref?.();
  store.__tunnelReputationTimer = setInterval(tick, DAY_MS);
  store.__tunnelReputationTimer.unref?.();
}
