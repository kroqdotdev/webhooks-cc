import { homeOrigin } from "@/lib/supabase/home-site";
import { decryptSigningSecret } from "@/lib/crypto";
import { sendEmail } from "@/lib/email/mailer";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AlertEventRow } from "@/lib/supabase/alerts";
import { NO_LAYOUT, PARSE_FAILED } from "./state";
import { byteaToBuffer } from "@/lib/supabase/destinations";
import { customChatPayload, isDiscordUrl, isSlackUrl } from "@/lib/forwarding/chat";
import { sendOptions } from "@/lib/forwarding/config";
import { isDelivered, jsonForward, sendForward } from "@/lib/forwarding/send";
import { forwardHeaders, FORWARD_USER_AGENT } from "@/lib/forwarding/sign";

/**
 * Tells the owner when an alert opens or resolves: an email from
 * webhooks.cc's own sender (never the capture domain), and a message to each
 * of the endpoint's destinations chosen for alerts (a chat message to Slack
 * or Discord, otherwise a signed `alert.opened` or `alert.resolved` JSON
 * event). A failed send is tried again on the next pass, at most five times.
 * Alerts carry field names and delivery errors, never an email's contents.
 */

const BATCH = 50;

interface AlertContext {
  slug: string;
  name: string | null;
  ownerEmail: string | null;
  /** The origin the owner's links lead to (their site). */
  origin: string;
  notifyEmail: boolean;
  destinationIds: string[];
  destinationNames: Map<string, string>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One-line summary and a few lines of explanation, for email and chat alike. */
export function describeAlert(
  event: Pick<AlertEventRow, "kind" | "subject" | "details" | "resolved_at">,
  endpointLabel: string,
  destinationName: string | null
): { summary: string; lines: string[] } {
  const details = (event.details ?? {}) as Record<string, unknown>;
  const resolved = event.resolved_at !== null;
  if (event.kind === "fields") {
    const all = Array.isArray(details.missing) ? (details.missing as string[]) : [];
    const noLayout = all.includes(NO_LAYOUT);
    const failed = all.includes(PARSE_FAILED);
    const missing = all.filter((name) => name !== NO_LAYOUT && name !== PARSE_FAILED);
    const what = missing.length > 0 ? missing.join(", ") : "a required field";
    const streak = typeof details.streak === "number" && details.streak > 0 ? details.streak : 0;
    if (resolved) {
      return {
        summary: `${endpointLabel}: email fields match again`,
        lines: ["The latest email had every required field."],
      };
    }
    const [summary, missed] = noLayout
      ? [`${endpointLabel}: no layout matched`, "matched no layout"]
      : failed
        ? [`${endpointLabel}: emails could not be parsed`, "could not be parsed"]
        : [`${endpointLabel}: ${what} stopped matching`, `missed ${what}`];
    return {
      summary,
      lines: [
        streak > 0
          ? `${plural(streak, "email", "emails")} in a row ${missed}.`
          : `Recent emails ${missed}.`,
        ...(typeof details.missedPercent === "number"
          ? [`${details.missedPercent}% of the last 20 emails missed a field.`]
          : []),
        noLayout
          ? "The sender may have changed its emails. Fix a layout's match conditions, then replay the emails that missed."
          : "The sender may have changed its layout. Fix the pattern, then replay the emails that missed.",
      ],
    };
  }
  if (event.kind === "silence") {
    const hours = typeof details.hours === "number" ? details.hours : null;
    return resolved
      ? { summary: `${endpointLabel}: email is arriving again`, lines: ["A new email arrived."] }
      : {
          summary: `${endpointLabel}: no email${hours ? ` for ${plural(hours, "hour", "hours")}` : ""}`,
          lines: [
            typeof details.lastEmailAt === "string"
              ? `The last email arrived at ${details.lastEmailAt}.`
              : "No email has arrived since alerts were turned on.",
          ],
        };
  }
  const name = destinationName ?? "A destination";
  return resolved
    ? {
        summary: `${endpointLabel}: ${name} is receiving deliveries again`,
        lines: ["A later delivery to it succeeded."],
      }
    : {
        summary: `${endpointLabel}: deliveries to ${name} are failing`,
        lines: [
          `${plural(typeof details.failed === "number" ? details.failed : 1, "delivery", "deliveries")} failed after every retry.`,
          ...(typeof details.lastError === "string" ? [`Last error: ${details.lastError}`] : []),
          "Redeliver them from the endpoint's delivery log once the destination is fixed.",
        ],
      };
}

async function contextFor(endpointId: string): Promise<AlertContext | null> {
  const admin = createAdminClient();
  const { data: endpoint, error } = await admin
    .from("endpoints")
    .select("slug, name, user_id")
    .eq("id", endpointId)
    .maybeSingle<{ slug: string; name: string | null; user_id: string | null }>();
  if (error) throw error;
  if (!endpoint) return null;
  const [
    { data: owner, error: ownerError },
    { data: settings, error: settingsError },
    { data: destinations, error: destinationsError },
  ] = await Promise.all([
    endpoint.user_id
      ? admin
          .from("users")
          .select("email, home_site")
          .eq("id", endpoint.user_id)
          .maybeSingle<{ email: string; home_site: string }>()
      : Promise.resolve({ data: null, error: null }),
    admin
      .from("endpoint_alerts")
      .select("notify_email, notify_destination_ids")
      .eq("endpoint_id", endpointId)
      .maybeSingle<{ notify_email: boolean; notify_destination_ids: string[] }>(),
    admin.from("endpoint_destinations").select("id, name, url").eq("endpoint_id", endpointId),
  ]);
  // A failed read must not look like "no owner" or "notify no one".
  if (ownerError) throw ownerError;
  if (settingsError) throw settingsError;
  if (destinationsError) throw destinationsError;
  const names = new Map<string, string>();
  for (const row of (destinations ?? []) as { id: string; name: string | null; url: string }[]) {
    let label = row.name;
    if (!label) {
      try {
        label = new URL(row.url).host;
      } catch {
        label = "a destination";
      }
    }
    names.set(row.id, label);
  }
  return {
    slug: endpoint.slug,
    name: endpoint.name,
    ownerEmail: owner?.email ?? null,
    // Where the owner's session is (users.home_site).
    origin: homeOrigin(owner?.home_site),
    notifyEmail: settings?.notify_email ?? true,
    destinationIds: settings?.notify_destination_ids ?? [],
    destinationNames: names,
  };
}

async function sendToDestination(
  destinationId: string,
  event: AlertEventRow,
  context: AlertContext,
  text: string
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("endpoint_destinations")
    .select("url, format, enabled, secret_encrypted")
    .eq("id", destinationId)
    .maybeSingle<{
      url: string;
      format: string | null;
      enabled: boolean;
      secret_encrypted: string | null;
    }>();
  if (error) throw error;
  // Gone or switched off: nothing to send, and nothing to retry.
  if (!data || !data.enabled || data.format === "sheets" || data.format === "file_drop")
    return true;
  const chat = data.format === "chat" || isSlackUrl(data.url) || isDiscordUrl(data.url);
  let outgoing;
  if (chat) {
    outgoing = jsonForward(
      data.url,
      { "content-type": "application/json", "user-agent": FORWARD_USER_AGENT },
      JSON.stringify(customChatPayload(text, data.url))
    );
  } else {
    if (!data.secret_encrypted) return true;
    const secret = decryptSigningSecret(byteaToBuffer(data.secret_encrypted));
    const body = JSON.stringify({
      type: event.resolved_at ? "alert.resolved" : "alert.opened",
      timestamp: new Date().toISOString(),
      data: {
        id: event.id,
        kind: event.kind,
        destinationId: event.subject,
        endpoint: { slug: context.slug, name: context.name },
        openedAt: event.opened_at,
        resolvedAt: event.resolved_at,
        details: event.details,
        message: text,
      },
    });
    // The webhook-id is per alert and state, so a retried notice is recognisably the same one.
    outgoing = jsonForward(
      data.url,
      forwardHeaders(secret, `${event.id}${event.resolved_at ? "r" : "o"}`, body),
      body
    );
  }
  const result = await sendForward(outgoing, sendOptions());
  return isDelivered(result);
}

async function notifyOne(event: AlertEventRow): Promise<boolean> {
  const context = await contextFor(event.endpoint_id);
  if (!context) return true;
  const label = context.name?.trim() || context.slug;
  const destinationName = event.subject
    ? (context.destinationNames.get(event.subject) ?? null)
    : null;
  const { summary, lines } = describeAlert(event, label, destinationName);
  const link = `${context.origin.replace(/\/+$/, "")}/dashboard?endpoint=${encodeURIComponent(context.slug)}`;
  const text = [summary, "", ...lines, "", `Open the endpoint: ${link}`].join("\n");
  let ok = true;
  if (context.notifyEmail && context.ownerEmail) {
    try {
      await sendEmail({
        to: context.ownerEmail,
        subject: `${event.resolved_at ? "Resolved" : "Alert"}: ${summary}`,
        text: `${text}\n\nYou get this because alerts are on for this endpoint. Change them in its settings.\n`,
      });
    } catch (error) {
      ok = false;
      reportError("[alerts] email failed", error, { alert: event.id });
    }
  }
  for (const destinationId of context.destinationIds) {
    try {
      if (
        !(await sendToDestination(
          destinationId,
          event,
          context,
          `${summary}\n${lines.join("\n")}\n${link}`
        ))
      ) {
        ok = false;
      }
    } catch (error) {
      ok = false;
      reportError("[alerts] destination notice failed", error, { alert: event.id });
    }
  }
  return ok;
}

/** Sends what opened or resolved since the last pass; notices are leased, so each goes once. */
export async function notifyAlerts(): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_alert_notices", { p_limit: BATCH });
  if (error) throw error;
  let sent = 0;
  for (const event of (data ?? []) as AlertEventRow[]) {
    const now = new Date().toISOString();
    // Opened and resolved before anyone was told: nothing worth saying.
    if (event.notified_open_at === null && event.resolved_at !== null) {
      await admin
        .from("alert_events")
        .update({ notified_open_at: now, notified_resolve_at: now, notify_claimed_until: null })
        .eq("id", event.id);
      continue;
    }
    let ok = false;
    try {
      ok = await notifyOne(event);
    } catch (error) {
      // One alert's failed read is retried with its attempts; the rest of the
      // batch is still sent.
      reportError("[alerts] notice failed", error, { alert: event.id });
    }
    const update = ok
      ? event.notified_open_at === null
        ? { notified_open_at: now, notify_claimed_until: null }
        : { notified_resolve_at: now, notify_claimed_until: null }
      : { notify_attempts: event.notify_attempts + 1, notify_claimed_until: null };
    const { error: updateError } = await admin
      .from("alert_events")
      .update(update)
      .eq("id", event.id);
    if (updateError) throw updateError;
    if (ok) sent++;
  }
  return sent;
}
