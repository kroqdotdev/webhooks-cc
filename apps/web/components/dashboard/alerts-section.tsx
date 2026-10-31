"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import type { EmailField } from "@webhooks-cc/sdk/email";
import {
  emitDashboardEndpointsChanged,
  fetchAiAssists,
  fetchAlerts,
  fetchDashboardEndpoint,
  fetchDashboardRequest,
  fetchDashboardRequests,
  fetchDestinations,
  replayEndpoint,
  saveAlerts,
  updateDashboardEndpoint,
  type DashboardAlertEvent,
  type DashboardAlertSettings,
  type DashboardDestination,
  type DashboardEndpoint,
} from "@/lib/dashboard-api";
import { cn } from "@/lib/utils";
import { AiAssistPanel } from "./ai-assist-panel";
import { Field, SaveFooter, Section, SwitchRow } from "./settings-primitives";

/** A field to repair and where it is defined: the endpoint's own fields (null), or a layout. */
type FieldAt = { field: EmailField; layoutId: string | null };

/**
 * Where the field an alert names is defined. A layout's fields win over the
 * endpoint's own (as when emails are read), so the layout the missed email
 * matched comes first; alerts from before layouts were recorded fall back
 * to the endpoint's own fields, then the first layout that has it.
 */
function fieldDefinition(
  endpoint: DashboardEndpoint,
  name: string,
  layoutId: string | null
): FieldAt | null {
  const layouts = endpoint.layouts ?? [];
  const matched = layoutId ? layouts.find((layout) => layout.id === layoutId) : undefined;
  const inMatched = (matched?.fields ?? []).find((field) => field.name === name);
  if (matched && inMatched) return { field: inMatched, layoutId: matched.id };
  const own = (endpoint.emailFields ?? []).find((field) => field.name === name);
  if (own) return { field: own, layoutId: null };
  if (layoutId) return null;
  for (const layout of layouts) {
    const found = (layout.fields ?? []).find((field) => field.name === name);
    if (found) return { field: found, layoutId: layout.id };
  }
  return null;
}

/** "" for an empty input (the rule is off), else the number. */
function numberOrNull(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

function textOf(value: number | null): string {
  return value === null ? "" : String(value);
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describe(event: DashboardAlertEvent, destinations: DashboardDestination[]): string {
  const details = event.details ?? {};
  if (event.kind === "fields") {
    const missing = Array.isArray(details.missing) ? (details.missing as string[]).join(", ") : "";
    return missing ? `Emails missed ${missing}` : "Emails missed a required field";
  }
  if (event.kind === "silence") {
    return typeof details.hours === "number"
      ? `No email for ${details.hours} hours`
      : "No email arrived";
  }
  const destination = destinations.find((d) => d.id === event.subject);
  return `Deliveries to ${destination?.name || destination?.url || "a destination"} failed`;
}

/**
 * Alerts for one endpoint: when its email fields stop matching, when mail
 * stops arriving, when a delivery fails for good. They email the owner and
 * can post to the endpoint's chat or webhook destinations; open alerts can
 * replay the emails that missed once the pattern is fixed.
 */
export function AlertsSection({ endpoint }: { endpoint: DashboardEndpoint }) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [loaded, setLoaded] = useState<DashboardAlertSettings | null>(null);
  const [events, setEvents] = useState<DashboardAlertEvent[]>([]);
  const [destinations, setDestinations] = useState<DashboardDestination[]>([]);
  const [draft, setDraft] = useState({
    enabled: false,
    failures: "3",
    share: "",
    silence: "",
    destinationFailures: true,
    notifyEmail: true,
    required: null as string[] | null,
    notifyDestinationIds: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [replayNote, setReplayNote] = useState<string | null>(null);
  // AI repair: a field an open alert says stopped matching, from recent emails.
  const [aiOffered, setAiOffered] = useState(false);
  const [repair, setRepair] = useState<FieldAt | null>(null);
  const [recent, setRecent] = useState<{ id: string; subject: string }[]>([]);
  const [repairNote, setRepairNote] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    fetchAiAssists(accessToken, endpoint.slug)
      .then((info) => setAiOffered(info.offered))
      .catch(() => setAiOffered(false));
  }, [accessToken, endpoint.slug]);

  /**
   * Opens the repair with the email the alert last saw miss the field first
   * (so it is among the picked samples, and a proposal must find a value in
   * it), then the newest others. An alert that did not record its layout
   * takes it from that email's own parse.
   */
  const startRepair = async (name: string, details: Record<string, unknown> | null) => {
    if (!accessToken) return;
    setRepairNote(null);
    const missedId =
      typeof details?.lastMissedRequestId === "string" ? details.lastMissedRequestId : null;
    const [requests, missed] = await Promise.all([
      fetchDashboardRequests(accessToken, endpoint.slug, 10, "email").catch(() => []),
      missedId
        ? fetchDashboardRequest(accessToken, missedId).catch(() => null)
        : Promise.resolve(null),
    ]);
    const layoutId =
      typeof details?.layoutId === "string"
        ? details.layoutId
        : (missed?.parsed?.layout?.id ?? null);
    const found = fieldDefinition(endpoint, name, layoutId);
    if (!found) {
      setRepairNote(`${name} is no longer defined, so there is nothing to repair.`);
      return;
    }
    const emails = [
      ...(missed?.kind === "email" ? [missed] : []),
      ...requests.filter((request) => request._id !== missed?._id),
    ].slice(0, 10);
    setRecent(
      emails.map((request) => ({
        id: request._id,
        subject: request.email?.subject || "(no subject)",
      }))
    );
    setRepair(found);
  };

  /**
   * Replaces the field where it was found (that one place only) and saves
   * the endpoint. The endpoint is read again first, so edits made since this
   * page loaded (another layout, another field) are kept. Throws when it
   * was not saved, so the panel lets the person try again.
   */
  const applyRepair = async (field: EmailField) => {
    if (!accessToken || !repair) return;
    try {
      const fresh = await fetchDashboardEndpoint(accessToken, endpoint.slug);
      const replace = (fields: EmailField[] | undefined) => {
        const list = fields ?? [];
        const at = list.findIndex((item) => item.name === field.name);
        return at < 0 ? null : list.map((item, i) => (i === at ? field : item));
      };
      let updates: Parameters<typeof updateDashboardEndpoint>[2];
      if (repair.layoutId === null) {
        const emailFields = replace(fresh.emailFields);
        if (!emailFields)
          throw new Error(`${field.name} is no longer one of the endpoint's fields.`);
        updates = { emailFields };
      } else {
        const layout = (fresh.layouts ?? []).find((item) => item.id === repair.layoutId);
        const fields = layout ? replace(layout.fields) : null;
        if (!fields) throw new Error(`${field.name} is no longer in that layout.`);
        updates = {
          layouts: (fresh.layouts ?? []).map((item) =>
            item.id === repair.layoutId ? { ...item, fields } : item
          ),
        };
      }
      await updateDashboardEndpoint(accessToken, endpoint.slug, updates);
      emitDashboardEndpointsChanged();
      setRepairNote(
        `Saved the new pattern for ${field.name}. Replay these emails to read them again.`
      );
    } catch (err) {
      setRepairNote(err instanceof Error ? err.message : "The field was not saved.");
      throw err;
    }
  };
  const fieldNames = useMemo(
    () => (endpoint.emailFields ?? []).map((field) => field.name),
    [endpoint.emailFields]
  );

  const reset = useCallback((settings: DashboardAlertSettings) => {
    setDraft({
      enabled: settings.enabled,
      failures: textOf(settings.fieldFailures),
      share: textOf(settings.fieldFailureShare),
      silence: textOf(settings.silenceHours),
      destinationFailures: settings.destinationFailures,
      notifyEmail: settings.notifyEmail,
      required: settings.requiredFields,
      notifyDestinationIds: settings.notifyDestinationIds,
    });
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      fetchAlerts(accessToken, endpoint.slug),
      fetchDestinations(accessToken, endpoint.slug),
    ])
      .then(([alerts, list]) => {
        if (cancelled) return;
        setLoaded(alerts.settings);
        setEvents(alerts.events);
        setDestinations(list);
        reset(alerts.settings);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [accessToken, endpoint.slug, reset]);

  const next: DashboardAlertSettings = {
    enabled: draft.enabled,
    fieldFailures: numberOrNull(draft.failures),
    fieldFailureShare: numberOrNull(draft.share),
    requiredFields: draft.required,
    silenceHours: numberOrNull(draft.silence),
    destinationFailures: draft.destinationFailures,
    notifyEmail: draft.notifyEmail,
    notifyDestinationIds: draft.notifyDestinationIds,
  };
  const dirty = loaded !== null && JSON.stringify(next) !== JSON.stringify(loaded);
  const invalid = (text: string, min: number, max: number) =>
    text.trim() !== "" &&
    (!Number.isInteger(Number(text)) || Number(text) < min || Number(text) > max);

  const save = async () => {
    setError(null);
    setSaved(false);
    if (!accessToken) return setError("Sign in again to save changes.");
    if (
      invalid(draft.failures, 1, 100) ||
      invalid(draft.share, 1, 100) ||
      invalid(draft.silence, 1, 720)
    ) {
      return setError("Check the numbers: whole numbers in range, or empty to turn a rule off.");
    }
    setSaving(true);
    try {
      const settings = await saveAlerts(accessToken, endpoint.slug, next);
      setLoaded(settings);
      reset(settings);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The changes were not saved.");
    } finally {
      setSaving(false);
    }
  };

  const replaySince = async (event: DashboardAlertEvent) => {
    if (!accessToken) return;
    setReplayNote(null);
    try {
      const result = await replayEndpoint(accessToken, endpoint.slug, {
        // A little before it opened: the emails that set it off came first.
        since: event.openedAt - 6 * 3_600_000,
        kind: "email",
      });
      setReplayNote(
        result.requests === 0
          ? "No emails to replay."
          : `Queued ${result.queued} of ${result.requests} emails to the destinations again.`
      );
    } catch (err) {
      setReplayNote(err instanceof Error ? err.message : "Replay failed.");
    }
  };

  const required = draft.required ?? fieldNames;
  const toggleRequired = (name: string) => {
    const set = new Set(required);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    const list = fieldNames.filter((field) => set.has(field));
    setDraft({ ...draft, required: list.length === fieldNames.length ? null : list });
  };
  const toggleDestination = (id: string) => {
    const ids = draft.notifyDestinationIds.includes(id)
      ? draft.notifyDestinationIds.filter((existing) => existing !== id)
      : [...draft.notifyDestinationIds, id];
    setDraft({ ...draft, notifyDestinationIds: ids });
  };

  return (
    <Section
      id="alerts"
      title="Alerts"
      description="Hear about it when this endpoint's email fields stop matching, when mail stops arriving or when a delivery fails for good."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Alert settings changed."
          onReset={() => loaded && reset(loaded)}
          onSave={() => void save()}
        />
      }
    >
      <SwitchRow
        id="alerts-enabled"
        label="Alerts"
        help="Checked about once a minute. You get one notice when an alert opens and one when it resolves."
        checked={draft.enabled}
        onChange={(enabled) => setDraft({ ...draft, enabled })}
      />
      {draft.enabled && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              id="alerts-failures"
              label="Misses in a row"
              help="Emails in a row missing a field. Empty: off."
              error={invalid(draft.failures, 1, 100) ? "1 to 100" : undefined}
            >
              <input
                id="alerts-failures"
                inputMode="numeric"
                value={draft.failures}
                onChange={(e) =>
                  setDraft({ ...draft, failures: e.target.value.replace(/[^\d]/g, "") })
                }
                className="ui-input w-full text-sm font-mono py-2!"
                placeholder="off"
              />
            </Field>
            <Field
              id="alerts-share"
              label="Share missed (%)"
              help="Of the last 20 emails. Empty: off."
              error={invalid(draft.share, 1, 100) ? "1 to 100" : undefined}
            >
              <input
                id="alerts-share"
                inputMode="numeric"
                value={draft.share}
                onChange={(e) =>
                  setDraft({ ...draft, share: e.target.value.replace(/[^\d]/g, "") })
                }
                className="ui-input w-full text-sm font-mono py-2!"
                placeholder="off"
              />
            </Field>
            <Field
              id="alerts-silence"
              label="Quiet for (hours)"
              help="No email at all for this long. Empty: off."
              error={invalid(draft.silence, 1, 720) ? "1 to 720" : undefined}
            >
              <input
                id="alerts-silence"
                inputMode="numeric"
                value={draft.silence}
                onChange={(e) =>
                  setDraft({ ...draft, silence: e.target.value.replace(/[^\d]/g, "") })
                }
                className="ui-input w-full text-sm font-mono py-2!"
                placeholder="off"
              />
            </Field>
          </div>
          {fieldNames.length > 0 ? (
            <Field label="Fields that must be found">
              <div className="flex flex-wrap gap-2">
                {fieldNames.map((name) => (
                  <label key={name} className="flex items-center gap-1.5 text-sm font-mono">
                    <input
                      type="checkbox"
                      checked={required.includes(name)}
                      onChange={() => toggleRequired(name)}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">
              Field rules need email fields: add some under Receiving.
            </p>
          )}
          <SwitchRow
            id="alerts-destinations"
            label="Failed deliveries"
            help="A delivery that failed after every retry opens an alert for its destination."
            checked={draft.destinationFailures}
            onChange={(destinationFailures) => setDraft({ ...draft, destinationFailures })}
          />
          <SwitchRow
            id="alerts-email"
            label="Email me"
            help="From webhooks.cc to your account's address."
            checked={draft.notifyEmail}
            onChange={(notifyEmail) => setDraft({ ...draft, notifyEmail })}
          />
          {destinations.length > 0 && (
            <Field label="Also post alerts to">
              <div className="space-y-1">
                {destinations.map((destination) => (
                  <label key={destination.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.notifyDestinationIds.includes(destination.id)}
                      onChange={() => toggleDestination(destination.id)}
                    />
                    <span className="truncate">{destination.name || destination.url}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
        </div>
      )}
      {events.length > 0 && (
        <div className="pt-4 border-t border-line/20">
          <h3 className="text-sm font-semibold mb-2">Recent alerts</h3>
          <ul className="space-y-2">
            {events.slice(0, 10).map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={cn(
                    "text-xs font-bold caps px-1.5 py-0.5 rounded-sm",
                    event.resolvedAt === null
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {event.resolvedAt === null ? "Open" : "Resolved"}
                </span>
                <span>{describe(event, destinations)}</span>
                <span className="text-xs text-muted-foreground">since {when(event.openedAt)}</span>
                {event.kind === "fields" && event.resolvedAt === null && (
                  <span className="ml-auto flex flex-wrap gap-2">
                    {aiOffered &&
                      (Array.isArray(event.details?.missing)
                        ? (event.details.missing as string[])
                        : []
                      )
                        .map((name) =>
                          fieldDefinition(
                            endpoint,
                            name,
                            typeof event.details?.layoutId === "string"
                              ? event.details.layoutId
                              : null
                          )
                        )
                        .filter((found): found is FieldAt => found !== null)
                        .slice(0, 3)
                        .map((found) => (
                          <button
                            key={found.field.name}
                            type="button"
                            onClick={() =>
                              void startRepair(found.field.name, event.details ?? null)
                            }
                            className="ui-btn-outline py-1! px-2! text-xs"
                          >
                            Fix {found.field.name} with AI
                          </button>
                        ))}
                    <button
                      type="button"
                      onClick={() => void replaySince(event)}
                      className="ui-btn-outline py-1! px-2! text-xs"
                    >
                      Replay these emails
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {replayNote && <p className="text-xs text-muted-foreground mt-2">{replayNote}</p>}
          {repair && (
            <div className="mt-3">
              <AiAssistPanel
                // A new repair starts afresh (its own emails picked), never with the last one's.
                key={`${repair.layoutId ?? ""}:${repair.field.name}`}
                slug={endpoint.slug}
                samples={recent}
                mode={{ kind: "repair", field: repair.field }}
                onAddField={applyRepair}
                onClose={() => setRepair(null)}
              />
            </div>
          )}
          {repairNote && <p className="text-xs text-muted-foreground mt-2">{repairNote}</p>}
        </div>
      )}
    </Section>
  );
}
