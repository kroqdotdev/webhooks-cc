"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Eye, EyeOff, Plus, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import type { ForwardTestResult } from "@/lib/dashboard-api";
import { formatDuration } from "@/lib/forwarding/timing";
import {
  MAX_OWNER_HEADERS,
  headerNameIssue,
  headerValueAllowed,
} from "@/lib/forwarding/header-rules";
import {
  FORWARD_TIMEOUT_SECONDS,
  chatServiceName,
  isConnectionError,
  isTimeoutError,
} from "@/lib/forwarding/display";

/**
 * Pieces of a destination's editor: the owner's header rows, the signing
 * secret, the headers webhooks.cc always adds, and the result of a test
 * delivery.
 */

// ---------------------------------------------------------------------------
// Header rows
// ---------------------------------------------------------------------------

export interface HeaderRow {
  id: number;
  name: string;
  /** The name as stored, when this row came from the saved set. */
  storedName: string | null;
  /** null keeps the stored value; a string is a new value. */
  value: string | null;
  /** The masked stored value, shown read-only until Replace. */
  masked: string | null;
}

interface RowIssue {
  name?: string;
  value?: string;
}

let nextRowId = 1;

export function rowsFromHeaders(
  headers: { name: string; value: string }[] | undefined
): HeaderRow[] {
  return (headers ?? []).map((header) => ({
    id: nextRowId++,
    name: header.name,
    storedName: header.name,
    value: null,
    masked: header.value,
  }));
}

export function isEmptyRow(row: HeaderRow): boolean {
  return row.name.trim() === "" && (row.value ?? "") === "" && row.masked === null;
}

/** The rows as they would be saved, for comparing with the saved set. */
export function serializeRows(rows: HeaderRow[]): string {
  return JSON.stringify(
    rows
      .filter((row) => !isEmptyRow(row))
      .map((row) => [row.name.trim(), row.value, row.value === null ? row.masked : null])
  );
}

/** The rows as the API takes them: a null value keeps the stored one. */
export function headersInput(rows: HeaderRow[]): { name: string; value: string | null }[] {
  return rows
    .filter((row) => !isEmptyRow(row))
    .map((row) => ({ name: row.name.trim(), value: row.value }));
}

function rowIssue(row: HeaderRow, index: number, rows: HeaderRow[]): RowIssue | null {
  if (isEmptyRow(row)) return null;
  const issue: RowIssue = {};
  const name = row.name.trim();
  if (!name) {
    issue.name = "Enter a name for this header.";
  } else {
    switch (headerNameIssue(name)) {
      case "invalid":
        issue.name = "Header names use letters, numbers and hyphens only.";
        break;
      case "webhooks-cc":
        issue.name = "webhooks-cc-* headers are added by webhooks.cc. Pick another name.";
        break;
      case "webhook":
        issue.name = "webhook-* headers carry the Standard Webhooks signature. Pick another name.";
        break;
      case "delivery":
        issue.name = name.toLowerCase().startsWith("cf-")
          ? "cf-* headers are set by Cloudflare on the way out. Pick another name."
          : "Host, Content-Length and Transfer-Encoding are set by the delivery. Pick another name.";
        break;
      default: {
        const lower = name.toLowerCase();
        const earlier = rows
          .slice(0, index)
          .some((other) => !isEmptyRow(other) && other.name.trim().toLowerCase() === lower);
        if (earlier) issue.name = `${name} is listed twice. Keep one.`;
      }
    }
  }
  const label = name || "this header";
  if (row.value === null) {
    if (row.masked === null || row.storedName !== name) issue.value = `Enter a value for ${label}.`;
  } else if (row.value === "") {
    issue.value = `Enter a value for ${label}.`;
  } else if (!headerValueAllowed(row.value)) {
    issue.value = "Use one line of up to 1,024 characters.";
  }
  return issue.name || issue.value ? issue : null;
}

/** How many header fields are wrong, for the save footer's count. */
export function headerIssueCount(rows: HeaderRow[]): number {
  const live = rows.filter((row) => !isEmptyRow(row));
  return (
    (live.length > MAX_OWNER_HEADERS ? 1 : 0) +
    rows.reduce((count, row, index) => {
      const issue = rowIssue(row, index, rows);
      return count + (issue?.name ? 1 : 0) + (issue?.value ? 1 : 0);
    }, 0)
  );
}

export function HeaderRowsEditor({
  rows,
  onChange,
  idPrefix,
  showIssues,
}: {
  rows: HeaderRow[];
  onChange: (next: HeaderRow[]) => void;
  idPrefix: string;
  /** Point out every problem (after a save attempt), not only touched rows. */
  showIssues: boolean;
}) {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [announce, setAnnounce] = useState("");
  const nameRefs = useRef(new Map<number, HTMLInputElement | null>());
  const addRef = useRef<HTMLButtonElement>(null);
  const issues = useMemo(
    () => new Map(rows.map((row, index) => [row.id, rowIssue(row, index, rows)] as const)),
    [rows]
  );
  const liveRows = rows.filter((row) => !isEmptyRow(row));
  const tooMany = liveRows.length > MAX_OWNER_HEADERS;
  const shows = (key: string) => showIssues || touched.has(key);
  const touch = (key: string) =>
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  const focusName = (id: number | null) =>
    requestAnimationFrame(() => {
      if (id !== null) nameRefs.current.get(id)?.focus();
      else addRef.current?.focus();
    });
  const addRow = () => {
    const id = nextRowId++;
    onChange([...rows, { id, name: "", storedName: null, value: "", masked: null }]);
    setAnnounce("Header added");
    focusName(id);
  };
  const removeRow = (index: number) => {
    const row = rows[index];
    const next = rows[index + 1];
    onChange(rows.filter((_, i) => i !== index));
    setAnnounce(`${row.name.trim() || "Header"} removed`);
    focusName(next ? next.id : null);
  };
  const updateRow = (id: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, index) => {
            const n = index + 1;
            const issue = issues.get(row.id) ?? null;
            const nameShown = shows(`h${row.id}n`) && !!issue?.name;
            const valueShown = shows(`h${row.id}v`) && !!issue?.value;
            const nameErrorId = `${idPrefix}-header-${row.id}-name-error`;
            const valueErrorId = `${idPrefix}-header-${row.id}-value-error`;
            const complete =
              !!row.name.trim() && !issue && (row.value === null || row.value !== "");
            return (
              <div
                key={row.id}
                role="group"
                aria-label={`Header ${n}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(140px,1fr)_minmax(0,2fr)_auto] gap-2 items-center"
              >
                <input
                  ref={(el) => {
                    nameRefs.current.set(row.id, el);
                  }}
                  aria-label={`Header ${n} name`}
                  value={row.name}
                  onChange={(e) => updateRow(row.id, { name: e.target.value })}
                  onBlur={() => touch(`h${row.id}n`)}
                  placeholder="Authorization"
                  aria-invalid={nameShown}
                  aria-describedby={nameShown ? nameErrorId : undefined}
                  className={cn(
                    "ui-input w-full text-[13px] font-mono py-1.5! min-w-0",
                    nameShown && "border-destructive!"
                  )}
                />
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={`Remove header ${row.name.trim() || n}`}
                  className="md:order-last inline-flex items-center justify-center h-7 w-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <div className="col-span-2 md:col-span-1 flex items-center gap-2 min-w-0">
                  {row.value === null && row.masked !== null ? (
                    <>
                      <input
                        aria-label={`Header ${n} value, hidden after saving`}
                        value={row.masked}
                        readOnly
                        className="ui-input flex-1 min-w-0 text-[13px] font-mono py-1.5! bg-muted/50 shadow-none!"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          updateRow(row.id, { value: "" });
                          setAnnounce(`${row.name.trim() || "Header"} value replaced`);
                        }}
                        className="ui-btn-outline py-1! px-2.5! text-xs shrink-0"
                      >
                        Replace
                      </button>
                    </>
                  ) : (
                    <input
                      aria-label={`Header ${n} value`}
                      value={row.value ?? ""}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                      onBlur={() => touch(`h${row.id}v`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && complete && index === rows.length - 1) {
                          e.preventDefault();
                          if (liveRows.length < MAX_OWNER_HEADERS) addRow();
                        }
                      }}
                      placeholder="Bearer ..."
                      aria-invalid={valueShown}
                      aria-describedby={valueShown ? valueErrorId : undefined}
                      className={cn(
                        "ui-input flex-1 min-w-0 text-[13px] font-mono py-1.5!",
                        valueShown && "border-destructive!"
                      )}
                    />
                  )}
                </div>
                {nameShown && (
                  <p id={nameErrorId} className="col-span-full text-xs text-destructive">
                    {issue?.name}
                  </p>
                )}
                {valueShown && (
                  <p id={valueErrorId} className="col-span-full text-xs text-destructive">
                    {issue?.value}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={addRef}
          type="button"
          onClick={addRow}
          disabled={liveRows.length >= MAX_OWNER_HEADERS}
          className={cn(
            "ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5",
            liveRows.length >= MAX_OWNER_HEADERS && "opacity-50 cursor-not-allowed"
          )}
        >
          <Plus className="h-3 w-3" />
          Add header
        </button>
        {(liveRows.length >= MAX_OWNER_HEADERS || tooMany) && (
          <span className={cn("text-xs", tooMany ? "text-destructive" : "text-muted-foreground")}>
            Headers are limited to {MAX_OWNER_HEADERS}.
          </span>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {announce}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headers webhooks.cc adds
// ---------------------------------------------------------------------------

const RELAY_HEADERS: [string, string][] = [
  ["webhooks-cc-received-at", "2026-10-10T15:25:09.231Z"],
  ["webhooks-cc-request-id", "7f3c9a2e-5b1d-4c8e-9a6f-2d4b8c1e7a90"],
  ["webhooks-cc-endpoint", "{slug}"],
  ["webhooks-cc-attempt", "1"],
  ["webhooks-cc-signature", "v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4="],
];

const JSON_HEADERS: [string, string][] = [
  ["webhook-id", "msg_7f3c9a2e5b1d4c8e9a6f2d4b8c1e7a90"],
  ["webhook-timestamp", "1791455109"],
  ["webhook-signature", "v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4="],
];

export const RELAY_VERIFY_DOC =
  "/docs/forwarding#check-that-a-relayed-request-came-from-webhookscc";
export const JSON_VERIFY_DOC = "/docs/forwarding#verify-the-signature";

export function AlwaysAddedHeaders({ relay, slug }: { relay: boolean; slug: string }) {
  const rows = relay ? RELAY_HEADERS : JSON_HEADERS;
  return (
    <div className="space-y-1.5">
      <pre className="ui-code text-xs! leading-[18px] p-3! whitespace-pre-wrap break-all">
        {rows.map(([name, value], index) => (
          <span key={name}>
            {index > 0 && "\n"}
            <span className="syntax-property">{name}</span>
            <span className="text-muted-foreground">: {value.replace("{slug}", slug)}</span>
          </span>
        ))}
      </pre>
      <p className="text-xs text-muted-foreground max-w-[62ch]">
        {relay ? (
          "Added to every as-received delivery, so your server can tell a relay from the original, measure the delay, and check it came from here. The body is never changed."
        ) : (
          <>
            The Standard Webhooks headers on every signed delivery. Every copy of one request
            carries the same <code className="font-mono">webhook-id</code>, so a handler that saw it
            before can skip it.
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The signing secret
// ---------------------------------------------------------------------------

export function SecretField({
  relay,
  email,
  load,
  rotate,
}: {
  /** As-received deliveries carry webhooks-cc-signature; the rest webhook-signature. */
  relay: boolean;
  /** Whether emails go here too (they are always signed JSON). */
  email: boolean;
  load: () => Promise<string>;
  rotate: () => Promise<string>;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = async (action: () => Promise<string>, failure: string) => {
    try {
      const value = await action();
      setSecret(value);
      setError(null);
      return value;
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      return null;
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <code className="ui-input flex-1 min-w-[220px] text-sm font-mono py-2! truncate">
          {secret ?? "whsec_" + "•".repeat(24)}
        </code>
        <button
          type="button"
          onClick={() =>
            secret ? setSecret(null) : void run(load, "The secret could not be loaded.")
          }
          className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
        >
          {secret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {secret ? "Hide" : "Reveal"}
        </button>
        <button
          type="button"
          onClick={() =>
            void (async () => {
              const value = secret ?? (await run(load, "The secret could not be copied."));
              if (value && (await copyToClipboard(value))) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })()
          }
          className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
        {confirmRotate ? (
          <>
            <button
              type="button"
              onClick={() =>
                void run(rotate, "The secret could not be replaced.").then(
                  (value) => value && setConfirmRotate(false)
                )
              }
              className="ui-btn-outline py-1! px-2.5! text-xs text-destructive"
            >
              Replace secret
            </button>
            <button
              type="button"
              onClick={() => setConfirmRotate(false)}
              className="ui-btn-outline py-1! px-2.5! text-xs"
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRotate(true)}
            className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" />
            Rotate
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground max-w-[62ch]">
        {confirmRotate ? (
          "Deliveries are signed with the new secret at once, so your server needs it before it can verify them again."
        ) : relay ? (
          <>
            Check the <code className="font-mono">webhooks-cc-signature</code> header with it on
            relayed requests
            {email && (
              <>
                , and <code className="font-mono">webhook-signature</code> on emails
              </>
            )}
            .{" "}
            <Link href={RELAY_VERIFY_DOC} className="underline underline-offset-2">
              How to verify
            </Link>
          </>
        ) : (
          <>
            Check the <code className="font-mono">webhook-signature</code> header with it (Standard
            Webhooks).{" "}
            <Link href={JSON_VERIFY_DOC} className="underline underline-offset-2">
              How to verify
            </Link>
          </>
        )}
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A test delivery's result
// ---------------------------------------------------------------------------

/** The direction under a failed test, by what came back. */
function testAdvice(test: ForwardTestResult, chat: boolean, service: string): string | null {
  if (test.status === null) {
    if (isTimeoutError(test.error)) {
      return `Your server did not answer in time. Deliveries wait ${FORWARD_TIMEOUT_SECONDS} s.`;
    }
    if (isConnectionError(test.error))
      return "The name did not resolve, or the connection was refused.";
    return test.error;
  }
  if (chat) return `${service} rejected the message; the response below says why.`;
  if (test.status === 401 || test.status === 403) {
    return "It rejected the request. If it expects a token, add it under Headers, save, and test again.";
  }
  if (test.status === 404) {
    return "Nothing listens at that path. Check the URL, and whether the request path should be appended (Advanced).";
  }
  if (test.status >= 500) {
    return "It failed while handling the request. Its logs will say why; the start of the response is below.";
  }
  if (test.status >= 300 && test.status < 400)
    return "Redirects are not followed. Use the final URL.";
  return "It rejected the request; the response below says why.";
}

const HOW: Record<string, string> = {
  chat: "as a message",
  json: "as signed JSON",
  template: "as your JSON",
};

export function TestResult({ test }: { test: ForwardTestResult }) {
  const chat = test.format === "chat";
  const service = chat ? chatServiceName(test.url) : "Your server";
  const answered = test.status !== null;
  let what: string;
  if (test.sample) {
    what =
      test.kind === "email"
        ? "A sample email, as none has arrived yet."
        : "A sample request, as none has arrived yet.";
  } else if (test.kind === "email") {
    const subject = test.request.subject || "(no subject)";
    what = `The newest email, ${subject}, ${HOW[test.format] ?? "as signed JSON"}.`;
  } else {
    let how = HOW[test.format] ?? "relayed as received";
    if (test.format === "as_received") {
      let path = "";
      try {
        path = new URL(test.url).pathname;
      } catch {
        // Keep the sentence without a path.
      }
      how = path ? `relayed as received to ${path}` : "relayed as received";
    }
    what = `The newest request, ${test.request.method} ${test.request.path}, ${how}.`;
  }

  if (test.delivered) {
    return (
      <>
        <p>
          <span className="font-semibold">{chat ? "Posted." : "Delivered."}</span> {service}{" "}
          answered <span className="font-mono">{test.status}</span> in{" "}
          <span className="font-mono">{formatDuration(test.durationMs)}</span>. {what}
        </p>
        {test.excerpt && (
          <pre className="ui-code text-xs! p-3! whitespace-pre-wrap break-all">{test.excerpt}</pre>
        )}
      </>
    );
  }
  let host = "The server";
  try {
    host = new URL(test.url).host;
  } catch {
    // Keep the generic name.
  }
  return (
    <>
      <p className="text-destructive">
        <span className="font-semibold">Not delivered.</span>{" "}
        {answered ? (
          <>
            {service} answered <span className="font-mono">{test.status}</span> in{" "}
            <span className="font-mono">{formatDuration(test.durationMs)}</span>.
          </>
        ) : isTimeoutError(test.error) ? (
          `No answer in ${FORWARD_TIMEOUT_SECONDS} s.`
        ) : isConnectionError(test.error) ? (
          `${host} could not be reached.`
        ) : null}
      </p>
      {testAdvice(test, chat, service) && (
        <p className="text-xs text-muted-foreground max-w-[62ch]">
          {testAdvice(test, chat, service)}
        </p>
      )}
      {test.excerpt && (
        <pre className="ui-code text-xs! p-3! whitespace-pre-wrap break-all">{test.excerpt}</pre>
      )}
    </>
  );
}
