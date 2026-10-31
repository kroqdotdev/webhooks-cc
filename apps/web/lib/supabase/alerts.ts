import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";

/**
 * Alerts (migration 00068): an endpoint can warn its owner when its email
 * fields stop matching, when mail stops arriving, or when a delivery fails
 * for good. Settings live in endpoint_alerts, every alert in alert_events;
 * lib/alerts/checker.ts opens and resolves them.
 */

export type AlertRow = Database["public"]["Tables"]["endpoint_alerts"]["Row"];
export type AlertEventRow = Database["public"]["Tables"]["alert_events"]["Row"];
export type AlertKind = AlertEventRow["kind"];

export interface AlertSettings {
  enabled: boolean;
  /** Emails in a row that miss a required field before an alert opens; null is off. */
  fieldFailures: number | null;
  /** Percent of the last 20 emails that missed one; null is off. */
  fieldFailureShare: number | null;
  /** Fields that must be found; null means every field. */
  requiredFields: string[] | null;
  /** Hours without an email before an alert opens; null is off. */
  silenceHours: number | null;
  /** An alert when a delivery fails for good. */
  destinationFailures: boolean;
  notifyEmail: boolean;
  /** This endpoint's destinations that also get alerts. */
  notifyDestinationIds: string[];
}

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  /** The destination, for destination alerts. */
  subject: string | null;
  openedAt: number;
  resolvedAt: number | null;
  details: Json;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: false,
  fieldFailures: 3,
  fieldFailureShare: null,
  requiredFields: null,
  silenceHours: null,
  destinationFailures: true,
  notifyEmail: true,
  notifyDestinationIds: [],
};

export function toAlertSettings(row: AlertRow | null): AlertSettings {
  if (!row) return { ...DEFAULT_ALERT_SETTINGS };
  return {
    enabled: row.enabled,
    fieldFailures: row.field_failures,
    fieldFailureShare: row.field_failure_share,
    requiredFields: row.required_fields,
    silenceHours: row.silence_hours,
    destinationFailures: row.destination_failures,
    notifyEmail: row.notify_email,
    notifyDestinationIds: row.notify_destination_ids,
  };
}

export function toAlertEvent(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    openedAt: Date.parse(row.opened_at),
    resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : null,
    details: row.details,
  };
}

/** Checks settings as the API receives them; a message for the caller, or the settings. */
export function parseAlertSettings(
  body: Record<string, unknown>,
  current: AlertSettings
): AlertSettings | string {
  const next = { ...current };
  const intOrNull = (key: string, min: number, max: number): number | null | undefined | string => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return `${key} must be a whole number from ${min} to ${max}, or null.`;
    }
    return value;
  };
  for (const key of ["enabled", "destinationFailures", "notifyEmail"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return `${key} must be true or false.`;
    next[key] = body[key] as boolean;
  }
  const failures = intOrNull("fieldFailures", 1, 100);
  if (typeof failures === "string") return failures;
  if (failures !== undefined) next.fieldFailures = failures;
  const share = intOrNull("fieldFailureShare", 1, 100);
  if (typeof share === "string") return share;
  if (share !== undefined) next.fieldFailureShare = share;
  const silence = intOrNull("silenceHours", 1, 720);
  if (typeof silence === "string") return silence;
  if (silence !== undefined) next.silenceHours = silence;
  if (body.requiredFields !== undefined) {
    if (body.requiredFields === null) next.requiredFields = null;
    else if (
      !Array.isArray(body.requiredFields) ||
      body.requiredFields.length > 50 ||
      !body.requiredFields.every((name) => typeof name === "string" && name.length <= 64)
    ) {
      return "requiredFields must be a list of field names, or null for all of them.";
    } else next.requiredFields = [...new Set(body.requiredFields as string[])];
  }
  if (body.notifyDestinationIds !== undefined) {
    const ids = body.notifyDestinationIds;
    if (
      !Array.isArray(ids) ||
      ids.length > 10 ||
      !ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    ) {
      return "notifyDestinationIds must be a list of this endpoint's destination ids.";
    }
    next.notifyDestinationIds = [...new Set(ids as string[])];
  }
  return next;
}

export async function getAlertSettings(endpointId: string): Promise<AlertSettings> {
  const { data, error } = await createAdminClient()
    .from("endpoint_alerts")
    .select("*")
    .eq("endpoint_id", endpointId)
    .maybeSingle<AlertRow>();
  if (error) throw error;
  return toAlertSettings(data);
}

/** Saves settings; checking starts within a minute. Destination ids must be the endpoint's. */
export async function saveAlertSettings(
  endpointId: string,
  settings: AlertSettings
): Promise<AlertSettings> {
  const admin = createAdminClient();
  if (settings.notifyDestinationIds.length > 0) {
    const { data, error } = await admin
      .from("endpoint_destinations")
      .select("id, format")
      .eq("endpoint_id", endpointId)
      .in("id", settings.notifyDestinationIds);
    if (error) throw error;
    // A spreadsheet or a file drop cannot take a notice: only the others are kept.
    const known = new Set(
      (data as { id: string; format: string | null }[])
        .filter((row) => row.format !== "sheets" && row.format !== "file_drop")
        .map((row) => row.id)
    );
    settings = {
      ...settings,
      notifyDestinationIds: settings.notifyDestinationIds.filter((id) => known.has(id)),
    };
  }
  const { data, error } = await admin
    .from("endpoint_alerts")
    .upsert(
      {
        endpoint_id: endpointId,
        enabled: settings.enabled,
        field_failures: settings.fieldFailures,
        field_failure_share: settings.fieldFailureShare,
        required_fields: settings.requiredFields,
        silence_hours: settings.silenceHours,
        destination_failures: settings.destinationFailures,
        notify_email: settings.notifyEmail,
        notify_destination_ids: settings.notifyDestinationIds,
        next_check_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint_id" }
    )
    .select("*")
    .single<AlertRow>();
  if (error) throw error;
  // Switching alerts off resolves what is open, so nothing stays raised unseen.
  if (!settings.enabled) {
    await admin
      .from("alert_events")
      .update({
        resolved_at: new Date().toISOString(),
        // No "resolved" message for alerts the owner turned off themselves.
        notified_resolve_at: new Date().toISOString(),
      })
      .eq("endpoint_id", endpointId)
      .is("resolved_at", null);
  }
  return toAlertSettings(data);
}

/** The newest alerts of an endpoint, open ones first. */
export async function listAlertEvents(endpointId: string, limit = 50): Promise<AlertEvent[]> {
  const { data, error } = await createAdminClient()
    .from("alert_events")
    .select("*")
    .eq("endpoint_id", endpointId)
    .order("opened_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200))
    .returns<AlertEventRow[]>();
  if (error) throw error;
  return (data ?? [])
    .map(toAlertEvent)
    .sort((a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null));
}
