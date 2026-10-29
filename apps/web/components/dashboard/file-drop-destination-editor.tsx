"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Condition } from "@webhooks-cc/sdk";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  createDestination,
  deleteDestination,
  testFileDrop,
  updateDestination,
  type DashboardDestination,
  type DestinationInput,
  type FileDropDestinationConfig,
} from "@/lib/dashboard-api";
import { ConditionList } from "./condition-list";
import { Field, Segmented, SwitchRow } from "./settings-primitives";

type Protocol = FileDropDestinationConfig["protocol"];
type Column = { header: string; value: string };

const DEFAULT_PORTS: Record<Exclude<Protocol, "s3">, number> = { sftp: 22, ftps: 21, ftp: 21 };

function defaultColumns(emailFieldNames: string[]): Column[] {
  return [
    { header: "Received", value: "{{ receivedAt }}" },
    { header: "From", value: "{{ from.address }}" },
    { header: "Subject", value: "{{ subject }}" },
    ...emailFieldNames.map((name) => ({ header: name, value: `{{ fields.${name} }}` })),
  ];
}

/**
 * A file drop destination (Business): where the files go (SFTP, FTPS, FTP
 * or S3-compatible storage), what each holds (CSV or XML rows from the
 * columns, or JSON documents), one per email or one per batch, and what it
 * takes. The password, private key or secret key is write only: the page
 * never gets it back, and changing where the drop goes asks for it again.
 */
export function FileDropDestinationEditor({
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
  const stored = (destination?.config ?? null) as FileDropDestinationConfig | null;
  const [name, setName] = useState(destination?.name ?? "");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [email, setEmail] = useState(destination?.email ?? true);
  const [http, setHttp] = useState(destination?.http ?? false);
  const [conditions, setConditions] = useState<Condition[]>(destination?.filter?.conditions ?? []);
  const [logic, setLogic] = useState<"and" | "or">(destination?.filter?.logic ?? "and");

  const [protocol, setProtocol] = useState<Protocol>(stored?.protocol ?? "sftp");
  const [host, setHost] = useState(stored?.host ?? "");
  const [port, setPort] = useState(String(stored?.port ?? DEFAULT_PORTS.sftp));
  const [username, setUsername] = useState(stored?.username ?? "");
  const [folder, setFolder] = useState(stored?.folder ?? "");
  const [hostKey, setHostKey] = useState(stored?.hostKey ?? null);
  // Sent only to forget the pinned key: otherwise the stored one is kept
  // (it may have been pinned since this editor opened).
  const [forgetHostKey, setForgetHostKey] = useState(false);
  const [tlsFingerprint, setTlsFingerprint] = useState(stored?.tlsFingerprint ?? "");
  const [endpoint, setEndpoint] = useState(stored?.endpoint ?? "");
  const [region, setRegion] = useState(stored?.region ?? "");
  const [bucket, setBucket] = useState(stored?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState(stored?.accessKeyId ?? "");
  const [useKey, setUseKey] = useState(false);
  const [secret, setSecret] = useState("");

  const [file, setFile] = useState<FileDropDestinationConfig["file"]>(stored?.file ?? "csv");
  const [rows, setRows] = useState<"email" | "line_items">(stored?.rows ?? "email");
  const [columns, setColumns] = useState<Column[]>(
    stored?.columns?.length ? stored.columns : defaultColumns(emailFieldNames)
  );
  const [prefix, setPrefix] = useState(stored?.prefix ?? "");
  const [batch, setBatch] = useState(stored?.batch ?? false);
  const [batchMinutes, setBatchMinutes] = useState(
    String(Math.max(1, Math.round((destination?.delaySeconds ?? 900) / 60)))
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const idPrefix = `drop-${destination?.id ?? "new"}`;
  const hasSecret = destination?.hasDropSecret ?? false;

  const pickProtocol = (next: Protocol) => {
    setProtocol(next);
    if (next !== "s3") {
      const current = Number(port);
      if (!port || Object.values(DEFAULT_PORTS).includes(current)) {
        setPort(String(DEFAULT_PORTS[next]));
      }
    }
  };

  const config = (): FileDropDestinationConfig => ({
    protocol,
    folder: folder.trim(),
    file,
    rows,
    columns: file === "json" ? [] : columns,
    prefix: prefix.trim(),
    batch,
    tlsFingerprint: protocol === "ftps" || protocol === "s3" ? tlsFingerprint.trim() || null : null,
    ...(protocol === "s3"
      ? {
          endpoint: endpoint.trim(),
          region: region.trim() || "us-east-1",
          bucket: bucket.trim(),
          accessKeyId: accessKeyId.trim(),
        }
      : {
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          ...(forgetHostKey ? { hostKey: null } : {}),
        }),
  });

  const secretInput = (): DestinationInput["dropSecret"] => {
    if (!secret) return undefined;
    if (protocol === "s3") return { secretAccessKey: secret };
    if (protocol === "sftp" && useKey) return { privateKey: secret };
    return { password: secret };
  };

  const save = async () => {
    if (!accessToken) return;
    setError(null);
    setSaved(false);
    setTested(null);
    if (!email && !http) return setError("Pick at least one kind of request.");
    if (file !== "json" && columns.some((column) => !column.header.trim())) {
      return setError("Give every column a header.");
    }
    const minutes = Number(batchMinutes);
    if (batch && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)) {
      return setError("Collect a batch for 1 to 60 minutes.");
    }
    setBusy("Saving...");
    try {
      const input: DestinationInput = {
        name: name.trim() || null,
        enabled,
        email,
        http,
        format: "file_drop",
        filter: conditions.length > 0 ? { logic, conditions } : null,
        // A batch collects for the destination's delay.
        delaySeconds: batch ? minutes * 60 : 0,
        config: config(),
        ...(secretInput() ? { dropSecret: secretInput() } : {}),
      };
      const result = destination
        ? await updateDestination(accessToken, slug, destination.id, input)
        : await createDestination(accessToken, slug, input);
      setSecret("");
      setForgetHostKey(false);
      setSaved(true);
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The destination could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!accessToken || !destination) return;
    setError(null);
    setTested(null);
    setBusy("Connecting...");
    try {
      const result = await testFileDrop(accessToken, slug, destination.id);
      if (!result.ok) {
        setError(result.error ?? "The test failed.");
      } else {
        if (result.hostKey) setHostKey(result.hostKey);
        setTested(`Connected and wrote ${result.file}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The test failed.");
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

  const secretLabel =
    protocol === "s3" ? "Secret key" : protocol === "sftp" && useKey ? "Private key" : "Password";

  return (
    <div className="space-y-5">
      <Field id={`${idPrefix}-name`} label="Name">
        <input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Orders to the ERP"
          maxLength={100}
          className="ui-input w-full text-sm py-2!"
        />
      </Field>

      <div className="pt-4 border-t border-line/20 space-y-3">
        <h3 className="text-sm font-semibold">Where the files go</h3>
        <Segmented<Protocol>
          name="Protocol"
          value={protocol}
          onChange={pickProtocol}
          options={[
            { value: "sftp", label: "SFTP" },
            { value: "ftps", label: "FTPS" },
            { value: "ftp", label: "FTP" },
            { value: "s3", label: "S3" },
          ]}
        />
        {protocol === "ftp" && (
          <p className="text-xs text-muted-foreground max-w-[62ch]">
            Plain FTP sends the password and the files unencrypted. Use FTPS or SFTP when the server
            offers them.
          </p>
        )}
        {protocol === "s3" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${idPrefix}-endpoint`}
              label="Endpoint"
              help="The storage's address, like https://s3.eu-central-1.amazonaws.com."
            >
              <input
                id={`${idPrefix}-endpoint`}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://s3.eu-central-1.amazonaws.com"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
            <Field id={`${idPrefix}-region`} label="Region">
              <input
                id={`${idPrefix}-region`}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
            <Field id={`${idPrefix}-bucket`} label="Bucket">
              <input
                id={`${idPrefix}-bucket`}
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="acme-orders"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
            <Field id={`${idPrefix}-access-key`} label="Access key ID">
              <input
                id={`${idPrefix}-access-key`}
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                autoComplete="off"
                className="ui-input w-full text-sm py-2! font-mono"
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <Field id={`${idPrefix}-host`} label="Host">
              <input
                id={`${idPrefix}-host`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="files.acme.com"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
            <Field id={`${idPrefix}-port`} label="Port">
              <input
                id={`${idPrefix}-port`}
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
            <Field id={`${idPrefix}-username`} label="Username">
              <input
                id={`${idPrefix}-username`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                className="ui-input w-full text-sm py-2!"
              />
            </Field>
          </div>
        )}
        {protocol === "sftp" && (
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} />
            Log in with a private key
          </label>
        )}
        <Field
          id={`${idPrefix}-secret`}
          label={secretLabel}
          help={
            hasSecret
              ? "Saved, and never shown again. Type a new one to replace it; changing the server asks for it again."
              : "Stored encrypted, and never shown again."
          }
        >
          {protocol === "sftp" && useKey ? (
            <textarea
              id={`${idPrefix}-secret`}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              rows={4}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              autoComplete="off"
              spellCheck={false}
              className="ui-input w-full text-xs py-2! font-mono"
            />
          ) : (
            <input
              id={`${idPrefix}-secret`}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasSecret ? "Saved" : ""}
              autoComplete="new-password"
              className="ui-input w-full text-sm py-2!"
            />
          )}
        </Field>
        <Field
          id={`${idPrefix}-folder`}
          label={protocol === "s3" ? "Key prefix" : "Folder"}
          help={
            protocol === "s3"
              ? "Files are written under this prefix, like in/orders."
              : "Relative to the login's home folder; it must exist. Empty writes to the home folder."
          }
        >
          <input
            id={`${idPrefix}-folder`}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={protocol === "s3" ? "in/orders" : "upload/orders"}
            className="ui-input w-full text-sm py-2! font-mono"
          />
        </Field>
        {(protocol === "ftps" || protocol === "s3") && (
          <Field
            id={`${idPrefix}-fingerprint`}
            label="Certificate fingerprint"
            help="Only for a self-signed certificate: its SHA-256 fingerprint, which is then the only certificate accepted."
          >
            <input
              id={`${idPrefix}-fingerprint`}
              value={tlsFingerprint}
              onChange={(e) => setTlsFingerprint(e.target.value)}
              placeholder="AB:CD:..."
              className="ui-input w-full text-xs py-2! font-mono"
            />
          </Field>
        )}
        {protocol === "sftp" && hostKey && (
          <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
            <span>
              Host key: <code className="font-mono">{hostKey}</code>
            </span>
            <button
              type="button"
              onClick={() => {
                setHostKey(null);
                setForgetHostKey(true);
              }}
              className="underline"
              title="Accept the key the server shows next time"
            >
              Forget it
            </button>
          </p>
        )}
      </div>

      <div className="pt-4 border-t border-line/20 space-y-3">
        <h3 className="text-sm font-semibold">What each file holds</h3>
        <Field label="Format">
          <Segmented<FileDropDestinationConfig["file"]>
            name="File format"
            value={file}
            onChange={setFile}
            options={[
              { value: "csv", label: "CSV" },
              { value: "xml", label: "XML" },
              { value: "json", label: "JSON" },
            ]}
          />
        </Field>
        {file === "json" ? (
          <p className="text-xs text-muted-foreground max-w-[62ch]">
            Each email as the signed JSON forwarding sends (requests as their request JSON), with
            parsed fields and line items.
          </p>
        ) : (
          <>
            <Field label="Rows">
              <Segmented<"email" | "line_items">
                name="Rows"
                value={rows}
                onChange={setRows}
                options={[
                  { value: "email", label: "A row per email" },
                  { value: "line_items", label: "A row per line item" },
                ]}
              />
            </Field>
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
              </div>
            </div>
          </>
        )}
        <Field label="Files">
          <Segmented<"email" | "batch">
            name="Files"
            value={batch ? "batch" : "email"}
            onChange={(value) => setBatch(value === "batch")}
            options={[
              { value: "email", label: "A file per email" },
              { value: "batch", label: "A file per batch" },
            ]}
          />
        </Field>
        {batch && (
          <Field
            id={`${idPrefix}-batch`}
            label="Collect for"
            help="Minutes from the first email of a batch until its file is written, with everything that arrived meanwhile."
          >
            <div className="flex items-center gap-2">
              <input
                id={`${idPrefix}-batch`}
                value={batchMinutes}
                onChange={(e) => setBatchMinutes(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                className="ui-input w-20 text-sm py-2!"
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </Field>
        )}
        <Field
          id={`${idPrefix}-prefix`}
          label="File name prefix"
          help={`Files are named ${prefix.trim() || ""}20261029-173326-3f2a9c1e${batch ? "-batch" : ""}.${file}: the time and the first request's id, so a retry replaces its own file.`}
        >
          <input
            id={`${idPrefix}-prefix`}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            maxLength={60}
            placeholder="orders-"
            className="ui-input w-56 text-sm py-2! font-mono"
          />
        </Field>
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
          emptyLabel="Everything it takes is written. Add a condition to write only some."
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
          help="Off keeps the destination but writes no files."
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
          {busy === "Saving..." ? busy : destination ? "Save destination" : "Add destination"}
        </button>
        {destination && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void test()}
            className="ui-btn-outline py-1.5! px-3! text-xs"
          >
            {busy === "Connecting..." ? busy : "Test the connection"}
          </button>
        )}
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
        {tested && <span className="text-xs text-muted-foreground">{tested}</span>}
        {error && <p className="w-full text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
