import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/mailer";
import { serverEnv } from "@/lib/env";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { webhooksOrigin } from "@/lib/site";
import type { Database } from "@/lib/supabase/database";
import { previewUrl, tunnelConfig } from "./config";
import { previewNameOf } from "./name-rules";
import { REPORT_KINDS, type ReportKind } from "./report-kinds";

/*
 * Reports of previews (abuse_reports): from visitors (the public form at
 * /report, which every preview's Report button links to), from the edge,
 * which flags pages that look like phishing, and from the daily reputation
 * check. Each names the account behind the preview when it can, so staff can
 * stop the share, block the name or suspend sharing from the operations
 * center. A flag blocks nothing by itself.
 *
 * What the EU Digital Services Act asks: a reporter who left an email hears
 * that the report arrived and what was decided (article 16), and the account
 * behind a preview taken down hears what was done and why (article 17),
 * except for child sexual abuse, where the police decide when the person may
 * know.
 */

export type ReportRow = Database["public"]["Tables"]["abuse_reports"]["Row"];
export type ReportSource = ReportRow["source"];

/** Where replies about reports and takedowns go. */
const ABUSE_INBOX = "support@webhooks.cc";

/** How long after a run ends a report still names its account. */
const ATTRIBUTE_DAYS = 7;

/** The preview name a reported address points at, or null when it is not a preview. */
export function reportedNameOf(address: string): string | null {
  const config = tunnelConfig();
  if (!config) return null;
  return previewNameOf(address, config.previewOrigin.host);
}

/**
 * The run live under a name now, else its latest run in the last week
 * (Cloudflare's CSAM email comes a day late, and the police want that run's
 * details), else the account that reserves the name. Random names are drawn
 * again later, so an older run says nothing about who runs the name now.
 */
export async function behind(
  name: string,
  now = Date.now()
): Promise<{ userId: string | null; shareId: string | null }> {
  const admin = createAdminClient();
  const { data: live, error } = await admin
    .from("tunnel_shares")
    .select("id, user_id")
    .eq("kind", "share")
    .eq("name", name)
    .is("ended_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (live) return { userId: live.user_id, shareId: live.id };
  const { data: last, error: lastError } = await admin
    .from("tunnel_shares")
    .select("id, user_id")
    .eq("kind", "share")
    .eq("name", name)
    .gt("ended_at", new Date(now - ATTRIBUTE_DAYS * 86_400_000).toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  if (last) return { userId: last.user_id, shareId: last.id };
  const { data: kept, error: keptError } = await admin
    .from("tunnel_names")
    .select("user_id")
    .eq("name", name)
    .maybeSingle();
  if (keptError) throw keptError;
  return { userId: kept?.user_id ?? null, shareId: null };
}

export interface ReportInput {
  url: string;
  name: string;
  kind: ReportKind;
  details: string;
  reporterName: string | null;
  reporterEmail: string | null;
  goodFaith: boolean;
  source: ReportSource;
}

/** Keeps a report, naming the account and run behind the preview. */
export async function createReport(input: ReportInput): Promise<ReportRow> {
  const found = await behind(input.name);
  const { data, error } = await createAdminClient()
    .from("abuse_reports")
    .insert({
      source: input.source,
      kind: input.kind,
      url: input.url.slice(0, 2000),
      name: input.name.slice(0, 63),
      user_id: found.userId,
      share_id: found.shareId,
      details: input.details.slice(0, 4000),
      reporter_name: input.reporterName?.slice(0, 200) || null,
      reporter_email: input.reporterEmail?.slice(0, 320) || null,
      good_faith: input.goodFaith,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export interface FlagInput {
  shareId: string;
  url: string;
  signals: string[];
  inBrowser: boolean;
}

/**
 * Records a phishing flag from the edge: one open flag per preview run. Null
 * when the run is unknown or already has an open flag.
 */
export async function createFlag(input: FlagInput): Promise<{ id: string } | null> {
  const admin = createAdminClient();
  const { data: share, error } = await admin
    .from("tunnel_shares")
    .select("id, user_id, name")
    .eq("id", input.shareId)
    .maybeSingle();
  if (error) throw error;
  if (!share) return null;
  const { data: open, error: openError } = await admin
    .from("abuse_reports")
    .select("id")
    .eq("share_id", share.id)
    .eq("source", "flag")
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (openError) throw openError;
  if (open) return null;
  const seen = input.inBrowser ? ", seen in a visitor's browser after the page's scripts ran" : "";
  const { data: row, error: insertError } = await admin
    .from("abuse_reports")
    .insert({
      source: "flag",
      kind: "phishing",
      url: input.url.slice(0, 2000),
      name: share.name ? share.name.slice(0, 63) : null,
      user_id: share.user_id,
      share_id: share.id,
      details: `The page has ${input.signals.join(" and ")}${seen}.`.slice(0, 4000),
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return row;
}

const ALERT_SUBJECTS: Record<ReportSource, string> = {
  form: "A preview was reported",
  flag: "A preview was flagged as possible phishing",
  reputation: "The preview domain is on a blocklist",
};

/**
 * Tells staff a report arrived, without its contents (they read it in the
 * operations center). A flood of reports fills the queue, not the inbox: at
 * most 20 alerts an hour, except child sexual abuse, which always goes.
 * Never throws.
 */
export async function tellStaffOfReport(
  id: string,
  source: ReportSource,
  kind: ReportKind | null = null
): Promise<void> {
  try {
    const urgent = kind === "csam";
    if (!urgent && (await checkRateLimitByKey("tunnels:report-alerts", 20, 3_600_000))) {
      console.warn("[tunnels] report alerts paused: over 20 this hour");
      return;
    }
    const { SUPPORT_ALERT_EMAIL } = serverEnv();
    await sendEmail({
      to: SUPPORT_ALERT_EMAIL,
      subject: urgent ? "URGENT: a preview was reported" : ALERT_SUBJECTS[source],
      text:
        `Report ${id} is waiting in the operations center:\n` +
        `${webhooksOrigin()}/ops/sharing\n` +
        (urgent
          ? "\nIt may be child sexual abuse. Do not open the address; follow the steps in the report.\n"
          : ""),
      headers: { "Auto-Submitted": "auto-generated" },
    });
  } catch (err) {
    console.error("[tunnels] report alert not sent", err instanceof Error ? err.message : err);
  }
}

/**
 * The preview a reporter is told about: its address, from the checked name.
 * What they typed goes to staff only, so a report cannot carry a stranger's
 * text to an inbox in our name.
 */
function reported(report: Pick<ReportRow, "name">): string {
  return (report.name && previewUrl(report.name)) || "the address you reported";
}

/** Tells a reporter who left an email that the report arrived; whether it went. */
export async function confirmReceived(report: ReportRow): Promise<boolean> {
  if (!report.reporter_email) return false;
  // One receipt an hour per address, so the form cannot mail someone else repeatedly.
  if (
    await checkRateLimitByKey(
      `tunnels:report-receipt:${createHash("sha256").update(report.reporter_email.toLowerCase()).digest("hex")}`,
      1,
      3_600_000
    )
  )
    return false;
  try {
    await sendEmail({
      to: report.reporter_email,
      subject: "We got your report",
      text:
        `Thank you for reporting ${reported(report)}. Someone at webhooks.cc will look at it, ` +
        `and we will write to you when we have decided what to do.\n\n` +
        `Your report went to webhooks.cc, the service that shares the preview, not to the person who made it.\n`,
      headers: { "Auto-Submitted": "auto-replied", "Reply-To": ABUSE_INBOX },
    });
    return true;
  } catch (err) {
    console.error("[tunnels] receipt not sent", err instanceof Error ? err.message : err);
    return false;
  }
}

/** "removed" or "kept", from what resolveReport stored. */
export function outcomeKind(outcome: string | null): "removed" | "kept" | null {
  if (!outcome) return null;
  if (outcome.startsWith("removed")) return "removed";
  if (outcome.startsWith("kept")) return "kept";
  return null;
}

/** Tells a reporter who left an email what was decided. Never throws. */
export async function tellDecision(report: ReportRow): Promise<void> {
  const outcome = outcomeKind(report.outcome);
  if (!report.reporter_email || !outcome) return;
  const url = reported(report);
  try {
    await sendEmail({
      to: report.reporter_email,
      subject: "About your report",
      text:
        (outcome === "removed"
          ? `We looked at ${url} after your report and took it down.`
          : `We looked at ${url} after your report and did not find a reason to take it down.`) +
        `\n\nIf you disagree, reply to this email with what we may have missed.\n`,
      headers: { "Auto-Submitted": "auto-generated", "Reply-To": ABUSE_INBOX },
    });
  } catch (err) {
    console.error("[tunnels] decision not sent", err instanceof Error ? err.message : err);
  }
}

/**
 * Tells the account behind a report what was taken down and why (the
 * statement of reasons), and records that it went. Not for child sexual
 * abuse. Whether it went.
 */
export async function sendStatementOfReasons(
  report: ReportRow,
  action: "blocked" | "suspended"
): Promise<boolean> {
  if (report.kind === "csam" || !report.user_id) return false;
  const admin = createAdminClient();
  const { data: owner, error } = await admin
    .from("users")
    .select("email")
    .eq("id", report.user_id)
    .maybeSingle();
  if (error) throw error;
  if (!owner?.email) return false;
  const found =
    report.source === "form"
      ? "Someone reported it, and a person at webhooks.cc looked at it."
      : "Our automatic checks flagged it, and a person at webhooks.cc looked at it.";
  const done =
    action === "suspended"
      ? "We suspended sharing on your account, so none of your previews are served and new shares are refused."
      : `We blocked the name ${report.name}, so it can no longer be shared.`;
  try {
    await sendEmail({
      to: owner.email,
      subject: "We took your preview down",
      text:
        `Your preview ${reported(report)} broke the webhooks.cc terms: ` +
        `${REPORT_KINDS[report.kind].label.toLowerCase()}. ${found} ${done}\n\n` +
        `Terms: ${webhooksOrigin()}/terms\n\n` +
        `If you think this is a mistake, reply to this email and say why. A person at webhooks.cc will look at it again.\n`,
      headers: { "Auto-Submitted": "auto-generated", "Reply-To": ABUSE_INBOX },
    });
  } catch (err) {
    console.error("[tunnels] statement not sent", err instanceof Error ? err.message : err);
    return false;
  }
  const { error: markError } = await admin
    .from("abuse_reports")
    .update({ statement_sent_at: new Date().toISOString() })
    .eq("id", report.id);
  if (markError) throw markError;
  return true;
}

export async function findReport(id: string): Promise<ReportRow | null> {
  const { data, error } = await createAdminClient()
    .from("abuse_reports")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Closes a report with what was decided: "removed" or "kept", then the note.
 * Null when it was resolved already.
 */
export async function resolveReport(input: {
  id: string;
  staffId: string;
  outcome: "removed" | "kept";
  note: string;
}): Promise<ReportRow | null> {
  const { data, error } = await createAdminClient()
    .from("abuse_reports")
    .update({
      status: "resolved",
      outcome: `${input.outcome}: ${input.note}`.slice(0, 200),
      resolved_by: input.staffId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function openReportCount(): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("abuse_reports")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  if (error) throw error;
  return count ?? 0;
}
