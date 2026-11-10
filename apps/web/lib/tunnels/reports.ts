import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/mailer";
import { serverEnv } from "@/lib/env";

/*
 * Reports of previews (abuse_reports): from visitors (the public form, later),
 * from the edge, which flags pages that look like phishing, and from the
 * daily reputation check. Each names the account behind the preview when it
 * can, so staff can stop the share, block the name or suspend sharing from
 * the operations center. A flag blocks nothing by itself.
 */

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

/**
 * Tells staff a report arrived, without its contents (they read it in the
 * operations center). Never throws.
 */
export async function tellStaffOfReport(id: string, source: "form" | "flag"): Promise<void> {
  try {
    const { SUPPORT_ALERT_EMAIL } = serverEnv();
    await sendEmail({
      to: SUPPORT_ALERT_EMAIL,
      subject:
        source === "flag" ? "A preview was flagged as possible phishing" : "A preview was reported",
      text: `Report ${id} is waiting in the operations center.\n`,
      headers: { "Auto-Submitted": "auto-generated" },
    });
  } catch (err) {
    console.error("[tunnels] report alert not sent", err instanceof Error ? err.message : err);
  }
}
