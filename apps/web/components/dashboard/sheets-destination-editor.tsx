"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import type { Condition } from "@webhooks-cc/sdk";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  createDestination,
  createGoogleSpreadsheet,
  deleteDestination,
  fetchGoogleConnections,
  fetchPickerToken,
  startGoogleConnect,
  updateDestination,
  type DashboardDestination,
  type GoogleConnectionsInfo,
  type SheetsDestinationConfig,
} from "@/lib/dashboard-api";
import { ConditionList } from "./condition-list";
import { Field, Segmented, SwitchRow } from "./settings-primitives";

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

declare global {
  interface Window {
    gapi?: { load: (name: string, callback: () => void) => void };
    google?: {
      picker: {
        PickerBuilder: new () => {
          addView: (view: unknown) => unknown;
          setOAuthToken: (token: string) => unknown;
          setDeveloperKey: (key: string) => unknown;
          setAppId: (id: string) => unknown;
          setCallback: (cb: (data: Record<string, unknown>) => void) => unknown;
          build: () => { setVisible: (visible: boolean) => void };
        };
        DocsView: new (viewId: unknown) => { setMimeTypes: (types: string) => unknown };
        ViewId: { SPREADSHEETS: unknown };
        Action: { PICKED: string };
      };
    };
  }
}

/** Loads Google's picker script once. */
function loadPicker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => window.gapi!.load("picker", () => resolve());
    if (window.gapi) return ready();
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error("Google's picker could not be loaded."));
    document.head.appendChild(script);
  });
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
}: {
  slug: string;
  destination: DashboardDestination | null;
  emailFieldNames?: string[];
  signingConfigured: boolean;
  onSaved: (saved: DashboardDestination) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const stored = destination?.config ?? null;
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
        setConnectionId((current) => current || info.connections[0]?.id || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [accessToken]);

  const headers = useMemo(() => columns.map((column) => column.header), [columns]);

  const connect = async () => {
    if (!accessToken) return;
    setError(null);
    try {
      const returnTo = `${window.location.pathname}${window.location.search}`;
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

  const pick = async () => {
    if (!accessToken || !connectionId) return;
    setError(null);
    try {
      const [token] = await Promise.all([
        fetchPickerToken(accessToken, connectionId),
        loadPicker(),
      ]);
      const picker = window.google!.picker;
      const view = new picker.DocsView(picker.ViewId.SPREADSHEETS);
      const builder = new picker.PickerBuilder();
      builder.addView(view);
      builder.setOAuthToken(token.accessToken);
      builder.setDeveloperKey(token.apiKey);
      builder.setAppId(token.appId);
      builder.setCallback((data) => {
        if (data.action !== picker.Action.PICKED) return;
        const doc = (data.docs as { id: string }[] | undefined)?.[0];
        if (doc?.id) setSpreadsheetId(doc.id);
      });
      builder.build().setVisible(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The picker could not open.");
    }
  };

  const config: SheetsDestinationConfig | null =
    connectionId && spreadsheetId ? { connectionId, spreadsheetId, sheet, rows, columns } : null;

  const save = async () => {
    if (!accessToken) return;
    setError(null);
    setSaved(false);
    if (!config) return setError("Connect a Google account and choose a spreadsheet first.");
    if (!email && !http) return setError("Pick at least one kind of request.");
    if (columns.some((column) => !column.header.trim())) {
      return setError("Give every column a header.");
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
      setSaved(true);
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be saved.");
    } finally {
      setBusy(null);
    }
  };

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
    return (
      <p className="text-sm text-muted-foreground">
        Google Sheets is not set up on this server yet.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <Field id={`${idPrefix}-name`} label="Name">
        <input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Orders sheet"
          maxLength={100}
          className="ui-input w-full text-sm py-2!"
        />
      </Field>

      <div className="pt-4 border-t border-line/20 space-y-3">
        <h3 className="text-sm font-semibold">Spreadsheet</h3>
        <Field label="Google account">
          <div className="flex flex-wrap items-center gap-2">
            {google && google.connections.length > 0 && (
              <select
                aria-label="Google account"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="ui-input text-sm py-1.5! px-2! w-72"
              >
                {google.connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.email ?? "Google account"}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void connect()}
              className="ui-btn-outline py-1.5! px-3! text-xs"
            >
              {google?.connections.length ? "Connect another account" : "Connect a Google account"}
            </button>
          </div>
        </Field>
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
                  <input
                    id={`${idPrefix}-title`}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    className="ui-input w-full text-sm py-2!"
                  />
                </Field>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void create()}
                  className="ui-btn-outline py-2! px-3! text-xs"
                >
                  Create it
                </button>
                {google?.picker && (
                  <button
                    type="button"
                    onClick={() => void pick()}
                    className="ui-btn-outline py-2! px-3! text-xs"
                  >
                    Choose from Drive
                  </button>
                )}
              </div>
            )}
            <Field
              id={`${idPrefix}-sheet`}
              label="Tab"
              help="The sheet the rows go to; it must exist in the spreadsheet."
            >
              <input
                id={`${idPrefix}-sheet`}
                value={sheet}
                onChange={(e) => setSheet(e.target.value)}
                maxLength={100}
                className="ui-input w-56 text-sm py-2!"
              />
            </Field>
          </>
        )}
      </div>

      <div className="pt-4 border-t border-line/20 space-y-3">
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
              <input
                aria-label={`Column ${index + 1} header`}
                value={column.header}
                onChange={(e) =>
                  setColumns(
                    columns.map((c, i) => (i === index ? { ...c, header: e.target.value } : c))
                  )
                }
                placeholder="Header"
                className="ui-input w-40 text-sm py-1.5!"
              />
              <input
                aria-label={`Column ${index + 1} value`}
                value={column.value}
                onChange={(e) =>
                  setColumns(
                    columns.map((c, i) => (i === index ? { ...c, value: e.target.value } : c))
                  )
                }
                placeholder="{{ subject }}"
                className="ui-input flex-1 text-sm font-mono py-1.5!"
              />
              <button
                type="button"
                aria-label={`Remove column ${index + 1}`}
                onClick={() => setColumns(columns.filter((_, i) => i !== index))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setColumns([...columns, { header: "", value: "" }])}
              className="ui-btn-outline py-1! px-2! text-xs inline-flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Column
            </button>
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

      <div className="pt-4 border-t border-line/20 space-y-3">
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

      <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-line/20">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void save()}
          className="ui-btn-primary py-1.5! px-3! text-xs"
        >
          {busy ?? (destination ? "Save destination" : "Add destination")}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-sm text-muted-foreground">
            Cancel
          </button>
        )}
        {destination && (
          <button
            type="button"
            onClick={() => void remove()}
            className="text-sm text-destructive ml-auto"
          >
            Remove
          </button>
        )}
        {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
        {error && <p className="w-full text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
