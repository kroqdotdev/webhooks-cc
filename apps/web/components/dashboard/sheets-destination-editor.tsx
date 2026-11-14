"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import type { Condition } from "@webhooks-cc/sdk";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  createDestination,
  createGoogleSpreadsheet,
  deleteDestination,
  fetchGoogleConnections,
  fetchSpreadsheetTabs,
  startDrivePick,
  startGoogleConnect,
  updateDestination,
  type DashboardDestination,
  type GoogleConnectionsInfo,
  type SheetsDestinationConfig,
} from "@/lib/dashboard-api";
import { ConditionList } from "./condition-list";
import {
  googleOutcomeMessage,
  googleReturnPath,
  type GoogleOutcome,
} from "@/lib/integrations/google-return";
import { Field, Segmented, SwitchRow } from "./settings-primitives";
import { useReportDirty } from "./dirty-sections";
import { Button } from "@/components/ui/button";
import { FieldControl } from "@/components/ui/field";

type Column = { header: string; value: string };

function defaultColumns(emailFieldNames: string[]): Column[] {
  return [
    { header: "Received", value: "{{ receivedAt }}" },
    { header: "From", value: "{{ from.address }}" },
    { header: "Subject", value: "{{ subject }}" },
    ...emailFieldNames.map((name) => ({ header: name, value: `{{ fields.${name} }}` })),
  ];
}

function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** Where the picked page (app/api/integrations/google/picked) posts the pick. */
const DRIVE_PICK_CHANNEL = "whcc-drive-pick";

function pickNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A Google Sheets destination: which account, which spreadsheet and tab,
 * and the columns, each a header and a value in placeholders. The app may
 * only use spreadsheets it created or that were picked for it (drive.file).
 */
export function SheetsDestinationEditor({
  slug,
  destination,
  emailFieldNames = [],
  signingConfigured,
  onSaved,
  onDeleted,
  onCancel,
  googleOutcome = null,
}: {
  slug: string;
  destination: DashboardDestination | null;
  emailFieldNames?: string[];
  signingConfigured: boolean;
  /** How connecting a Google account just went, back from Google. */
  googleOutcome?: GoogleOutcome | null;
  onSaved: (saved: DashboardDestination) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const stored = (destination?.config ?? null) as SheetsDestinationConfig | null;
  const [google, setGoogle] = useState<GoogleConnectionsInfo | null>(null);
  const [name, setName] = useState(destination?.name ?? "");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [email, setEmail] = useState(destination?.email ?? true);
  const [http, setHttp] = useState(destination?.http ?? false);
  const [conditions, setConditions] = useState<Condition[]>(destination?.filter?.conditions ?? []);
  const [logic, setLogic] = useState<"and" | "or">(destination?.filter?.logic ?? "and");
  const [connectionId, setConnectionId] = useState(stored?.connectionId ?? "");
  const [spreadsheetId, setSpreadsheetId] = useState(stored?.spreadsheetId ?? "");
  const [sheet, setSheet] = useState(stored?.sheet ?? "Sheet1");
  const [rows, setRows] = useState<"email" | "line_items">(stored?.rows ?? "email");
  const [columns, setColumns] = useState<Column[]>(
    stored?.columns ?? defaultColumns(emailFieldNames)
  );
  const [title, setTitle] = useState("webhooks.cc " + slug);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const idPrefix = `sheets-${destination?.id ?? "new"}`;

  useEffect(() => {
    if (!accessToken) return;
    fetchGoogleConnections(accessToken)
      .then((info) => {
        setGoogle(info);
        // Back from connecting one: the account just connected (the newest).
        const newest =
          googleOutcome === "connected"
            ? [...info.connections].sort((a, b) => b.createdAt - a.createdAt)[0]?.id
            : undefined;
        setConnectionId((current) => newest || current || info.connections[0]?.id || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // googleOutcome is read once, when the editor opens on the way back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const outcomeMessage = googleOutcome ? googleOutcomeMessage(googleOutcome) : null;
  // Back from Google, the page opens at its top: bring the outcome into view.
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (googleOutcome) outcomeRef.current?.scrollIntoView({ block: "center" });
  }, [googleOutcome]);

  const headers = useMemo(() => columns.map((column) => column.header), [columns]);

  // The chosen spreadsheet's tabs, so the tab is picked from what is there
  // (a sheet made in another language calls its first tab "Ark1" or "Hoja 1",
  // not "Sheet1"). A tab that is not there becomes the first one.
  const [tabs, setTabs] = useState<string[] | null>(null);
  // Saving waits for the list, so it never sends the tab the list would change.
  const [tabsPending, setTabsPending] = useState(false);
  useEffect(() => {
    setTabs(null);
    setTabsPending(false);
    if (!accessToken || !connectionId || !spreadsheetId) return;
    let current = true;
    setTabsPending(true);
    fetchSpreadsheetTabs(accessToken, connectionId, spreadsheetId)
      .then((found) => {
        if (!current) return;
        setTabs(found);
        setSheet((tab) => (found.length > 0 && !found.includes(tab) ? found[0] : tab));
      })
      // Without the list the tab stays a text field, and saving says what is wrong.
      .catch(() => undefined)
      .finally(() => {
        if (current) setTabsPending(false);
      });
    return () => {
      current = false;
    };
  }, [accessToken, connectionId, spreadsheetId]);

  const connect = async () => {
    if (!accessToken) return;
    setError(null);
    try {
      // Back to this page, with this editor open again to say how it went.
      const returnTo = googleReturnPath(window.location.href, destination?.id ?? "new");
      window.location.assign(await startGoogleConnect(accessToken, returnTo));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google could not be reached.");
    }
  };

  const create = async () => {
    if (!accessToken || !connectionId) return;
    setBusy("Creating the spreadsheet...");
    setError(null);
    try {
      const created = await createGoogleSpreadsheet(accessToken, {
        connectionId,
        title,
        sheet,
        headers,
      });
      setSpreadsheetId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The spreadsheet could not be created.");
    } finally {
      setBusy(null);
    }
  };

  // Row 1 of the owner's sheet is theirs: written only when they ask.
  const [headerWritten, setHeaderWritten] = useState(false);
  const writeHeaders = async () => {
    if (!accessToken || !connectionId || !spreadsheetId) return;
    setBusy("Writing the headers...");
    setError(null);
    setHeaderWritten(false);
    try {
      await createGoogleSpreadsheet(accessToken, { connectionId, spreadsheetId, sheet, headers });
      setHeaderWritten(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The headers could not be written.");
    } finally {
      setBusy(null);
    }
  };

  // Google's picker opens in a pop-up as a page of its own: the embedded one
  // needs third-party cookies, which many browsers block. The pick comes back
  // from the picked page on a BroadcastChannel, with the nonce of this pick.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel(DRIVE_PICK_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { nonce?: unknown; file?: unknown; error?: unknown } | null;
      if (!pending.current || data?.nonce !== pending.current) return;
      pending.current = null;
      if (typeof data.file === "string") setSpreadsheetId(data.file);
      else if (data.error === "expired") {
        setError("Google's window was open too long. Choose from Drive again.");
      } else if (data.error !== "cancelled") setError("Google did not say which spreadsheet.");
    };
    return () => channel.close();
  }, []);

  const pick = async () => {
    if (!accessToken || !connectionId) return;
    setError(null);
    // The pick comes back on a BroadcastChannel; without one it never would.
    if (typeof BroadcastChannel !== "function") {
      setError("This browser cannot take the pick back from Google. Use a current browser.");
      return;
    }
    // Opened in the click itself, so pop-up blockers let it through; Google's
    // page goes in once the server has made its URL.
    const popup = window.open("", "whcc-drive-pick", "popup,width=960,height=720");
    if (!popup) {
      setError("Your browser blocked Google's window. Allow pop-ups for this site and try again.");
      return;
    }
    const nonce = pickNonce();
    pending.current = nonce;
    try {
      const url = await startDrivePick(accessToken, connectionId, nonce);
      // A later click has taken over the window: its own URL goes in.
      if (pending.current === nonce) popup.location.href = url;
    } catch (err) {
      if (pending.current !== nonce) return;
      popup.close();
      pending.current = null;
      setError(err instanceof Error ? err.message : "The picker could not open.");
    }
  };

  const config: SheetsDestinationConfig | null =
    connectionId && spreadsheetId ? { connectionId, spreadsheetId, sheet, rows, columns } : null;

  // The form as it would be saved, to tell unsaved edits. A new destination
  // picks the first Google account on its own, which is not an edit.
  const formState = () =>
    JSON.stringify({
      name,
      enabled,
      email,
      http,
      conditions,
      logic,
      connectionId: destination ? connectionId : null,
      spreadsheetId,
      sheet,
      rows,
      columns,
    });
  const [savedState, setSavedState] = useState(formState);
  const dirty = formState() !== savedState;

  // Resolves true once it saved, for a save started from outside the editor.
  const runSave = async (): Promise<boolean> => {
    if (!accessToken) return false;
    setError(null);
    setSaved(false);
    if (!config) {
      setError("Connect a Google account and choose a spreadsheet first.");
      return false;
    }
    if (!email && !http) {
      setError("Pick at least one kind of request.");
      return false;
    }
    if (columns.some((column) => !column.header.trim())) {
      setError("Give every column a header.");
      return false;
    }
    setBusy("Saving...");
    try {
      // The sheet's header row first, so a Google failure stops the save with
      // nothing half done. The server leaves a first row that holds anything
      // but this destination's own earlier headers as it is.
      const sameSheet = stored?.spreadsheetId === spreadsheetId && stored?.sheet === sheet;
      const previous = sameSheet ? (stored?.columns.map((c) => c.header) ?? []) : [];
      if (!sameSheet || JSON.stringify(previous) !== JSON.stringify(headers)) {
        await createGoogleSpreadsheet(accessToken, {
          connectionId,
          spreadsheetId,
          sheet,
          headers,
          previousHeaders: previous,
        });
      }
      const input = {
        name: name.trim() || null,
        url: spreadsheetUrl(spreadsheetId),
        enabled,
        email,
        http,
        format: "sheets" as const,
        filter: conditions.length > 0 ? { logic, conditions } : null,
        config,
      };
      const result = destination
        ? await updateDestination(accessToken, slug, destination.id, input)
        : await createDestination(accessToken, slug, input);
      setSavedState(formState());
      setSaved(true);
      onSaved(result);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  // A save asked for while one runs (Save and leave right after Save) is the
  // same save, not a second request that would add the destination twice.
  const savingRef = useRef<Promise<boolean> | null>(null);
  const save = (): Promise<boolean> => {
    savingRef.current ??= runSave().finally(() => {
      savingRef.current = null;
    });
    return savingRef.current;
  };

  // An edited destination counts as unsaved settings, like a section's own form.
  useReportDirty(dirty, save);

  const remove = async () => {
    if (!accessToken || !destination) return;
    try {
      await deleteDestination(accessToken, slug, destination.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be removed.");
    }
  };

  if (google && !google.available) {
    // The picker no longer offers Sheets then; this is for a destination made before.
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Google Sheets is not set up on this server yet.
        </p>
        {onCancel && (
          <Button
            variant="surface"
            className="py-1.5! px-3! text-xs"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Field id={`${idPrefix}-name`} label="Name">
        <FieldControl
          className="w-full text-sm py-2!"
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Orders sheet"
          maxLength={100}
        />
      </Field>

      <div className="pt-4 border-t border-border/20 space-y-3">
        <h3 className="text-sm font-semibold">Spreadsheet</h3>
        <Field label="Google account">
          <div className="flex flex-wrap items-center gap-2">
            {google && google.connections.length > 0 && (
              <FieldControl
                className="text-sm py-1.5! px-2! w-72"
                render={
                  <select
                    aria-label="Google account"
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                  />
                }
              >
                {google.connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.email ?? "Google account"}
                  </option>
                ))}
              </FieldControl>
            )}
            <Button
              variant="surface"
              className="py-1.5! px-3! text-xs"
              type="button"
              onClick={() => void connect()}
            >
              {google?.connections.length ? "Connect another account" : "Connect a Google account"}
            </Button>
          </div>
        </Field>
        {outcomeMessage && (
          <p
            className={
              outcomeMessage.ok
                ? "text-sm border rounded-md p-3"
                : "text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3"
            }
            ref={outcomeRef}
            role={outcomeMessage.ok ? "status" : "alert"}
            data-testid="google-outcome"
          >
            {outcomeMessage.text}
          </p>
        )}
        {connectionId && (
          <>
            {spreadsheetId ? (
              <p className="text-sm flex flex-wrap items-center gap-2">
                <a
                  href={spreadsheetUrl(spreadsheetId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline"
                >
                  Open the spreadsheet <ExternalLink className="h-3 w-3" />
                </a>
                <button
                  type="button"
                  onClick={() => setSpreadsheetId("")}
                  className="text-xs text-muted-foreground underline"
                >
                  Choose another
                </button>
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <Field id={`${idPrefix}-title`} label="New spreadsheet" className="flex-1 min-w-56">
                  <FieldControl
                    className="w-full text-sm py-2!"
                    id={`${idPrefix}-title`}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                  />
                </Field>
                <Button
                  variant="surface"
                  className="py-2! px-3! text-xs"
                  type="button"
                  disabled={!!busy}
                  onClick={() => void create()}
                >
                  Create it
                </Button>
                <Button
                  variant="surface"
                  className="py-2! px-3! text-xs"
                  type="button"
                  onClick={() => void pick()}
                >
                  Choose from Drive
                </Button>
              </div>
            )}
            <Field
              id={`${idPrefix}-sheet`}
              label="Tab"
              help="The sheet the rows go to; it must exist in the spreadsheet."
            >
              {tabs && tabs.length > 0 ? (
                <FieldControl
                  className="w-56 text-sm py-2! px-2!"
                  render={
                    <select
                      id={`${idPrefix}-sheet`}
                      value={sheet}
                      onChange={(e) => setSheet(e.target.value)}
                    />
                  }
                >
                  {tabs.map((tab) => (
                    <option key={tab} value={tab}>
                      {tab}
                    </option>
                  ))}
                </FieldControl>
              ) : (
                <FieldControl
                  className="w-56 text-sm py-2!"
                  id={`${idPrefix}-sheet`}
                  value={sheet}
                  onChange={(e) => setSheet(e.target.value)}
                  maxLength={100}
                />
              )}
            </Field>
          </>
        )}
      </div>

      <div className="pt-4 border-t border-border/20 space-y-3">
        <h3 className="text-sm font-semibold">Rows</h3>
        <Segmented<"email" | "line_items">
          name="Rows"
          value={rows}
          onChange={setRows}
          options={[
            { value: "email", label: "One per email" },
            { value: "line_items", label: "One per line item" },
          ]}
        />
        <p className="text-xs text-muted-foreground max-w-[62ch]">
          {rows === "email"
            ? "Each captured request adds a row."
            : "Each line item a layout found adds a row, with {{ item.<field> }} for its values; an email without line items adds one row."}
        </p>
        <div className="space-y-2">
          {columns.map((column, index) => (
            <div key={index} className="flex items-center gap-2">
              <FieldControl
                className="w-40 text-sm py-1.5!"
                aria-label={`Column ${index + 1} header`}
                value={column.header}
                onChange={(e) =>
                  setColumns(
                    columns.map((c, i) => (i === index ? { ...c, header: e.target.value } : c))
                  )
                }
                placeholder="Header"
              />
              <FieldControl
                className="flex-1 text-sm font-mono py-1.5!"
                aria-label={`Column ${index + 1} value`}
                value={column.value}
                onChange={(e) =>
                  setColumns(
                    columns.map((c, i) => (i === index ? { ...c, value: e.target.value } : c))
                  )
                }
                placeholder="{{ subject }}"
              />
              <button
                type="button"
                aria-label={`Remove column ${index + 1}`}
                onClick={() => setColumns(columns.filter((_, i) => i !== index))}
                className="text-muted-foreground hover:text-destructive-ink"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="surface"
              className="py-1! px-2! text-xs inline-flex items-center gap-1"
              type="button"
              onClick={() => setColumns([...columns, { header: "", value: "" }])}
            >
              <Plus className="h-3 w-3" /> Column
            </Button>
            <button
              type="button"
              onClick={() => setColumns(defaultColumns(emailFieldNames))}
              className="text-xs text-muted-foreground underline"
            >
              Reset to the standard columns
            </button>
            {spreadsheetId && connectionId ? (
              <button
                type="button"
                onClick={writeHeaders}
                disabled={busy !== null || headers.some((header) => !header.trim())}
                className="text-xs text-muted-foreground underline disabled:opacity-50"
              >
                Write these headers to row 1 of {sheet || "Sheet1"}
              </button>
            ) : null}
            {headerWritten ? (
              <span className="text-xs text-muted-foreground">Headers written.</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-border/20 space-y-3">
        <h3 className="text-sm font-semibold">What it gets</h3>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
            Emails
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" checked={http} onChange={(e) => setHttp(e.target.checked)} />
            HTTP requests
          </label>
        </div>
        <ConditionList
          conditions={conditions}
          logic={logic}
          use="filter"
          idPrefix={idPrefix}
          showRequired={false}
          emptyLabel="Everything it takes adds rows. Add a condition to add only some."
          emailFieldNames={emailFieldNames}
          onChange={(next) => {
            setConditions(next.conditions);
            setLogic(next.logic);
          }}
        />
        {conditions.some((c) => c.field === "signature") && !signingConfigured && (
          <p className="text-xs text-muted-foreground">
            Set up signature verification for this endpoint first.
          </p>
        )}
        <SwitchRow
          id={`${idPrefix}-enabled`}
          label="On"
          help="Off keeps the destination but adds no rows."
          checked={enabled}
          onChange={setEnabled}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-border/20">
        <Button
          variant="primary"
          className="py-1.5! px-3! text-xs"
          type="button"
          disabled={!!busy || tabsPending}
          onClick={() => void save()}
        >
          {busy ?? (destination ? "Save destination" : "Add destination")}
        </Button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-sm text-muted-foreground">
            Cancel
          </button>
        )}
        {destination && (
          <button
            type="button"
            onClick={() => void remove()}
            className="text-sm text-destructive-ink ml-auto"
          >
            Remove
          </button>
        )}
        {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
        {error && <p className="w-full text-sm text-destructive-ink">{error}</p>}
      </div>
    </div>
  );
}
