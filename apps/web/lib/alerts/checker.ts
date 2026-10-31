import { createAdminClient } from "@/lib/supabase/admin";
import type { AlertKind, AlertRow } from "@/lib/supabase/alerts";
import type { Database, Json } from "@/lib/supabase/database";

type AlertUpdate = Database["public"]["Tables"]["endpoint_alerts"]["Update"];
import { toEmailCapture } from "@/lib/email-capture";
import { emailFieldValues, storedEmailFields } from "@/lib/email-fields";
import { storedLayouts } from "@/lib/parsing/stored";
import type { ParsedEmail } from "@webhooks-cc/sdk/email";
import { reportError } from "@/lib/observability";
import {
  fieldAlertDue,
  layoutMissing,
  missingFields,
  missShare,
  nextFieldState,
  requiredFieldNames,
} from "./state";
import { notifyAlerts } from "./notify";

/**
 * Opens and resolves alerts (migration 00068). Every minute each endpoint
 * with alerts on is leased (claim_alert_checks) and checked:
 *
 * - fields: the emails that arrived since the last check, in order, each
 *   found or missing a required email field (on an endpoint with layouts:
 *   matched a layout and found its fields, once the parse is done); an
 *   alert opens after N misses in a row or when a share of the last 20
 *   missed, and resolves once an email has every field again and the share
 *   is below the line;
 * - silence: no email for N hours (counted from the last email, or from when
 *   alerts were set up); resolves when one arrives;
 * - destinations: a delivery that failed for good opens an alert for its
 *   destination; a later successful delivery there resolves it.
 *
 * Alerts read the stored emails and the delivery log, never the capture
 * path, so a slow check cannot slow a capture. notify.ts sends what opened
 * or resolved.
 */

const POLL_MS = 30_000;
const CHECK_EVERY_MS = 60_000;
const BATCH = 20;
const EMAILS_PER_CHECK = 200;

type EndpointRow = {
  id: string;
  slug: string;
  email_fields: Json;
  last_email_at: string | null;
  layouts: Json;
};

type EmailRow = {
  id: string;
  kind: string;
  email: Json;
  headers: Json;
  received_at: string;
  request_parses?: ParseSummary | ParseSummary[] | null;
};

/** What alerts read of a parse: its status and summary, never the whole result. */
type ParseSummary = { status: string; summary?: Json | null };

/**
 * How far back each check looks again: an email the MX host retried keeps
 * its first arrival time (up to an hour old), so it can be stored after the
 * cursor passed it. Ids already checked are skipped.
 */
const LATE_ARRIVAL_MS = 65 * 60_000;
const SEEN_IDS = 500;

async function openAlert(
  endpointId: string,
  kind: AlertKind,
  subject: string | null,
  details: Json
): Promise<void> {
  const admin = createAdminClient();
  let query = admin
    .from("alert_events")
    .select("id")
    .eq("endpoint_id", endpointId)
    .eq("kind", kind)
    .is("resolved_at", null);
  query = subject === null ? query.is("subject", null) : query.eq("subject", subject);
  const { data, error } = await query.maybeSingle<{ id: string }>();
  if (error) throw error;
  if (data) {
    // Already open: keep its details current.
    const { error: updateError } = await admin
      .from("alert_events")
      .update({ details })
      .eq("id", data.id);
    if (updateError) throw updateError;
    return;
  }
  const { error: insertError } = await admin
    .from("alert_events")
    .insert({ endpoint_id: endpointId, kind, subject, details });
  // A unique violation means another check opened it first.
  if (insertError && insertError.code !== "23505") throw insertError;
}

async function resolveAlert(
  endpointId: string,
  kind: AlertKind,
  subject: string | null
): Promise<void> {
  let query = createAdminClient()
    .from("alert_events")
    .update({ resolved_at: new Date().toISOString() })
    .eq("endpoint_id", endpointId)
    .eq("kind", kind)
    .is("resolved_at", null);
  query = subject === null ? query.is("subject", null) : query.eq("subject", subject);
  const { error } = await query;
  if (error) throw error;
}

/** The field rules: new emails in order, the streak and share, open or resolve. */
async function checkFields(
  alert: AlertRow,
  endpoint: EndpointRow,
  update: AlertUpdate
): Promise<void> {
  const fields = storedEmailFields(endpoint.email_fields);
  const required = requiredFieldNames(
    fields.map((field) => field.name),
    alert.required_fields
  );
  const layouts = storedLayouts(endpoint.layouts);
  const admin = createAdminClient();
  const columns =
    layouts.length > 0
      ? "id, kind, email, headers, received_at, request_parses(status, summary)"
      : "id, kind, email, headers, received_at";
  const emails = () =>
    admin.from("requests").select(columns).eq("endpoint_id", endpoint.id).eq("kind", "email");

  // New emails past the cursor, in order.
  const cursor = alert.checked_through ?? alert.created_at;
  let fresh = emails()
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(EMAILS_PER_CHECK);
  fresh = alert.checked_through_id
    ? fresh.or(
        `received_at.gt.${cursor},and(received_at.eq.${cursor},id.gt.${alert.checked_through_id})`
      )
    : fresh.gt("received_at", cursor);
  const { data: freshData, error } = await fresh;
  if (error) throw error;
  let rows = (freshData ?? []) as unknown as EmailRow[];
  if (layouts.length > 0) {
    // An email whose parse is still running is checked once it is done,
    // and so is every later one, so outcomes stay in order.
    const pending = rows.findIndex((row) => parseOf(row) === "pending");
    if (pending >= 0) rows = rows.slice(0, pending);
  }

  // Late arrivals: a message the MX host retried keeps its first arrival
  // time, so it can be stored behind the cursor. The window behind it is
  // read whole when seen_ids can cover it; a busier endpoint skips this,
  // since retried mail is rare and scoring an email twice is worse.
  const seen = new Set(alert.seen_ids ?? []);
  let late: EmailRow[] = [];
  if (alert.checked_through) {
    const from = Math.max(
      Date.parse(alert.checked_through) - LATE_ARRIVAL_MS,
      Date.parse(alert.created_at)
    );
    const { data: windowData, error: windowError } = await emails()
      .gt("received_at", new Date(from).toISOString())
      .lte("received_at", alert.checked_through)
      .order("received_at", { ascending: true })
      .limit(SEEN_IDS + 1);
    if (windowError) throw windowError;
    const window = (windowData ?? []) as unknown as EmailRow[];
    if (window.length <= SEEN_IDS) {
      const cursorMs = Date.parse(alert.checked_through);
      const cursorId = alert.checked_through_id ?? "";
      late = window.filter(
        (row) =>
          !seen.has(row.id) &&
          parseOf(row) !== "pending" &&
          // Rows at the cursor's time with a later id are the cursor pass's.
          (Date.parse(row.received_at) < cursorMs || row.id <= cursorId)
      );
    }
  }
  if (rows.length === 0 && late.length === 0) return;
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    update.checked_through = last.received_at;
    update.checked_through_id = last.id;
  }
  rows = [...late, ...rows];
  update.seen_ids = [...(alert.seen_ids ?? []), ...rows.map((row) => row.id)].slice(-SEEN_IDS);

  // Without fields (or layouts, where no match is a miss) there is nothing to miss.
  if (
    (required.length === 0 && layouts.length === 0) ||
    (alert.field_failures === null && alert.field_failure_share === null)
  ) {
    return;
  }
  let lastMissing: string[] = [];
  let lastMissingId: string | null = null;
  // The layout that email matched: where a missing field is defined.
  let lastMissingLayoutId: string | null = null;
  const counted = layouts.length > 0 ? rows.filter((row) => parseOf(row) !== "none") : rows;
  if (counted.length === 0) return;
  const outcomes = counted.map((row) => {
    const values = emailFieldValues(
      {
        id: row.id,
        kind: "email",
        email: toEmailCapture(row.email),
        headers: (row.headers ?? {}) as Record<string, string>,
      },
      fields
    );
    const parse = layouts.length > 0 ? parseOf(row) : "none";
    const missing =
      layouts.length > 0
        ? layoutMissing(
            parse,
            values,
            fields.map((field) => field.name),
            alert.required_fields
          )
        : missingFields(values, required);
    if (missing.length > 0) {
      lastMissing = missing;
      lastMissingId = row.id;
      lastMissingLayoutId = typeof parse === "object" ? (parse.layout?.id ?? null) : null;
    }
    return missing.length === 0;
  });
  const state = nextFieldState(
    { streak: alert.failure_streak, recent: alert.recent_outcomes },
    outcomes
  );
  update.failure_streak = state.streak;
  update.recent_outcomes = state.recent;
  const rules = {
    fieldFailures: alert.field_failures,
    fieldFailureShare: alert.field_failure_share,
  };
  if (fieldAlertDue(rules, state)) {
    await openAlert(endpoint.id, "fields", null, {
      missing: lastMissing,
      lastMissedRequestId: lastMissingId,
      layoutId: lastMissingLayoutId,
      streak: state.streak,
      missedPercent: missShare(state.recent),
    });
  } else if (state.streak === 0) {
    await resolveAlert(endpoint.id, "fields", null);
  }
}

/** The parse of an email on an endpoint with layouts: pending, failed, or its result. */
function parseOf(row: EmailRow): "none" | "pending" | "failed" | ParsedEmail {
  const parse = Array.isArray(row.request_parses) ? row.request_parses[0] : row.request_parses;
  // No job at all: captured before the endpoint had layouts; not counted.
  if (!parse) return "none";
  if (parse.status === "pending") return "pending";
  if (parse.status !== "done") return "failed";
  const summary = (parse.summary ?? null) as {
    status?: unknown;
    layout?: { id?: unknown; name?: unknown } | null;
    fields?: unknown;
  } | null;
  if (summary?.status !== "matched" && summary?.status !== "no_layout") return "failed";
  const layout = summary.layout;
  return {
    status: summary.status,
    layout:
      layout && typeof layout.id === "string"
        ? { id: layout.id, name: typeof layout.name === "string" ? layout.name : "" }
        : null,
    fields:
      summary.fields && typeof summary.fields === "object"
        ? (summary.fields as Record<string, string | null>)
        : {},
    lineItems: [],
    lineItemColumns: [],
    attachments: [],
    pages: 0,
  };
}

async function checkSilence(alert: AlertRow, endpoint: EndpointRow): Promise<void> {
  if (alert.silence_hours === null) {
    await resolveAlert(endpoint.id, "silence", null);
    return;
  }
  // The endpoint row says when mail last arrived, also for endpoints that
  // delete their requests once delivered; older rows fall back to the newest
  // stored email.
  let lastEmailAt = endpoint.last_email_at;
  if (!lastEmailAt) {
    const { data, error } = await createAdminClient()
      .from("requests")
      .select("received_at")
      .eq("endpoint_id", endpoint.id)
      .eq("kind", "email")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ received_at: string }>();
    if (error) throw error;
    lastEmailAt = data?.received_at ?? null;
  }
  // Counted from the last email, or from when alerts were set up.
  const since = Math.max(Date.parse(lastEmailAt ?? alert.created_at), Date.parse(alert.created_at));
  if (Date.now() - since >= alert.silence_hours * 3_600_000) {
    await openAlert(endpoint.id, "silence", null, {
      lastEmailAt,
      hours: alert.silence_hours,
    });
  } else {
    await resolveAlert(endpoint.id, "silence", null);
  }
}

async function checkDestinations(
  alert: AlertRow,
  endpoint: EndpointRow,
  update: AlertUpdate
): Promise<void> {
  const admin = createAdminClient();
  const since = alert.deliveries_checked_through ?? alert.created_at;
  const { data, error } = await admin
    .from("email_deliveries")
    .select("destination_id, status, finished_at, last_error")
    .eq("endpoint_id", endpoint.id)
    .in("status", ["failed", "succeeded"])
    .gt("finished_at", since)
    .order("finished_at", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const rows = (data ?? []) as {
    destination_id: string | null;
    status: string;
    finished_at: string;
    last_error: string | null;
  }[];
  if (rows.length === 0) return;
  update.deliveries_checked_through = rows[rows.length - 1].finished_at;
  if (!alert.destination_failures) return;

  // Per destination, the latest outcome decides: failed opens, succeeded resolves.
  const latest = new Map<string, { failed: number; last: (typeof rows)[number] }>();
  for (const row of rows) {
    if (!row.destination_id) continue;
    const entry = latest.get(row.destination_id) ?? { failed: 0, last: row };
    if (row.status === "failed") entry.failed++;
    entry.last = row;
    latest.set(row.destination_id, entry);
  }
  for (const [destinationId, { failed, last }] of latest) {
    if (last.status === "failed") {
      await openAlert(endpoint.id, "destination", destinationId, {
        failed,
        lastError: last.last_error,
        lastFailedAt: last.finished_at,
      });
    } else {
      await resolveAlert(endpoint.id, "destination", destinationId);
    }
  }
}

/** Checks one leased endpoint and releases it until its next check. */
export async function checkEndpointAlerts(alert: AlertRow): Promise<void> {
  const admin = createAdminClient();
  const update: AlertUpdate = {};
  let checked = false;
  try {
    const { data: endpoint, error } = await admin
      .from("endpoints")
      .select("id, slug, email_fields, last_email_at, layouts")
      .eq("id", alert.endpoint_id)
      .maybeSingle<EndpointRow>();
    if (error) throw error;
    if (!endpoint) return;
    await checkFields(alert, endpoint, update);
    await checkSilence(alert, endpoint);
    await checkDestinations(alert, endpoint, update);
    checked = true;
  } finally {
    // A check that failed part way (an alert that could not be written)
    // keeps the old cursors, so the same emails and deliveries are looked at
    // again next time rather than skipped.
    const { error } = await admin
      .from("endpoint_alerts")
      .update({
        ...(checked ? update : {}),
        locked_until: null,
        next_check_at: new Date(Date.now() + CHECK_EVERY_MS).toISOString(),
      })
      .eq("endpoint_id", alert.endpoint_id);
    if (error) reportError("[alerts] could not release an endpoint", error);
  }
}

/** One pass: checks every due endpoint, then sends notifications. */
export async function runAlertChecks(): Promise<number> {
  const { data, error } = await createAdminClient().rpc("claim_alert_checks", {
    p_limit: BATCH,
    p_lease_seconds: 120,
  });
  if (error) throw error;
  const alerts = (data ?? []) as AlertRow[];
  for (const alert of alerts) {
    try {
      await checkEndpointAlerts(alert);
    } catch (checkError) {
      reportError("[alerts] check failed", checkError, { endpoint: alert.endpoint_id });
    }
  }
  await notifyAlerts();
  return alerts.length;
}

const globalForAlerts = globalThis as unknown as { __alertChecker?: NodeJS.Timeout };

export function startAlertChecker(): void {
  if (globalForAlerts.__alertChecker) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while ((await runAlertChecks()) === BATCH) {
        // more endpoints are due
      }
    } catch (error) {
      reportError("[alerts] pass failed", error);
    } finally {
      running = false;
    }
  };
  globalForAlerts.__alertChecker = setInterval(() => void tick(), POLL_MS);
  globalForAlerts.__alertChecker.unref();
  void tick();
}
