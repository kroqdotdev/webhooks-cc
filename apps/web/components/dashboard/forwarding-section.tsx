"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, Eye, EyeOff, Plus, RefreshCw, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import {
  fetchForwardSecret,
  rotateForwardSecret,
  sendForwardTest,
  type DashboardEndpoint,
  type ForwardFormatSetting,
  type ForwardTestResult,
} from "@/lib/dashboard-api";
import { isChatUrl } from "@/lib/forwarding/format";
import { checkSentField, formatDuration } from "@/lib/forwarding/timing";
import {
  MAX_OWNER_HEADERS,
  headerNameIssue,
  headerValueAllowed,
} from "@/lib/forwarding/header-rules";
import {
  FORWARD_TIMEOUT_SECONDS,
  chatServiceName,
  describeRetryWindow,
  formatCappedCount,
  isConnectionError,
  isTimeoutError,
} from "@/lib/forwarding/display";
import { StatusDot } from "./delivery-journey";
import { Field, SaveFooter, Section, Segmented, SwitchRow, useSave } from "./settings-primitives";
import { useDeliverySummary, useDocumentVisible, useOnScreen } from "./use-delivery-summary";

type Format = "as_received" | "json" | "chat";
type Retry = 0 | 3600 | 86400;

interface HeaderRow {
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

const RETRY_OPTIONS: { value: `${Retry}`; label: string }[] = [
  { value: "0", label: "Never" },
  { value: "3600", label: "For 1 hour" },
  { value: "86400", label: "For 1 day" },
];

const FORMAT_OPTIONS: { value: Format; label: string }[] = [
  { value: "as_received", label: "As received" },
  { value: "json", label: "Signed JSON" },
  { value: "chat", label: "Chat message" },
];

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

const RELAY_VERIFY_DOC = "/docs/forwarding#check-that-a-relayed-request-came-from-webhookscc";
const JSON_VERIFY_DOC = "/docs/forwarding#verify-the-signature";

let nextRowId = 1;

function rowsFromEndpoint(headers: { name: string; value: string }[] | undefined): HeaderRow[] {
  return (headers ?? []).map((header) => ({
    id: nextRowId++,
    name: header.name,
    storedName: header.name,
    value: null,
    masked: header.value,
  }));
}

function isEmptyRow(row: HeaderRow): boolean {
  return row.name.trim() === "" && (row.value ?? "") === "" && row.masked === null;
}

/** The rows as they would be saved, for comparing with the saved set. */
function serializeRows(rows: HeaderRow[]): string {
  return JSON.stringify(
    rows
      .filter((row) => !isEmptyRow(row))
      .map((row) => [row.name.trim(), row.value, row.value === null ? row.masked : null])
  );
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
    // A kept value only exists under the name it was stored with.
    if (row.masked === null || row.storedName !== name) issue.value = `Enter a value for ${label}.`;
  } else if (row.value === "") {
    issue.value = `Enter a value for ${label}.`;
  } else if (!headerValueAllowed(row.value)) {
    issue.value = "Use one line of up to 1,024 characters.";
  }
  return issue.name || issue.value ? issue : null;
}

function HeaderCode({ rows, slug }: { rows: [string, string][]; slug: string }) {
  return (
    <pre className="ui-code text-xs! leading-[18px] p-3! whitespace-pre-wrap break-all">
      {rows.map(([name, value], index) => (
        <span key={name}>
          {index > 0 && "\n"}
          <span className="syntax-property">{name}</span>
          <span className="text-muted-foreground">: {value.replace("{slug}", slug)}</span>
        </span>
      ))}
    </pre>
  );
}

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

function TestResult({ test }: { test: ForwardTestResult }) {
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
    what = `The newest email, ${subject}, ${chat ? "as a message" : "as signed JSON"}.`;
  } else {
    let how = "as a message";
    if (test.format === "json") how = "as signed JSON";
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

export function ForwardingSection({
  endpoint,
  onSeeDeliveries,
}: {
  endpoint: DashboardEndpoint;
  onSeeDeliveries: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const sectionRef = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(sectionRef);
  const documentVisible = useDocumentVisible();

  // Saved values. The rows are keyed on their serialised form so that a
  // refetch with the same values does not discard edits.
  // By value: a refetch returns a new array, and must not reset unsaved edits.
  const headersJson = JSON.stringify(endpoint.forwardHeaders ?? []);
  const initial = useMemo(
    () => ({
      enabled: endpoint.forwardEnabled === true,
      url: endpoint.forwardUrl ?? "",
      http: endpoint.forwardHttp === true,
      email: endpoint.forwardEmail !== false,
      format: (endpoint.forwardFormat ?? "auto") as ForwardFormatSetting,
      appendPath: endpoint.forwardAppendPath !== false,
      retry: (endpoint.forwardRetrySeconds ?? 86400) as Retry,
      keepOrder: endpoint.forwardKeepOrder === true,
      sentField: endpoint.forwardSentField ?? "",
      headersJson,
    }),
    [
      endpoint.forwardEnabled,
      endpoint.forwardUrl,
      endpoint.forwardHttp,
      endpoint.forwardEmail,
      endpoint.forwardFormat,
      endpoint.forwardAppendPath,
      endpoint.forwardRetrySeconds,
      endpoint.forwardKeepOrder,
      endpoint.forwardSentField,
      headersJson,
    ]
  );
  const initialRows = useMemo(
    () => rowsFromEndpoint(JSON.parse(initial.headersJson) as { name: string; value: string }[]),
    [initial.headersJson]
  );

  const [enabled, setEnabled] = useState(initial.enabled);
  const [url, setUrl] = useState(initial.url);
  const [http, setHttp] = useState(initial.http);
  const [email, setEmail] = useState(initial.email);
  const [format, setFormat] = useState<ForwardFormatSetting>(initial.format);
  const [appendPath, setAppendPath] = useState(initial.appendPath);
  const [retry, setRetry] = useState<Retry>(initial.retry);
  const [keepOrder, setKeepOrder] = useState(initial.keepOrder);
  const [sentField, setSentField] = useState(initial.sentField);
  const [rows, setRows] = useState<HeaderRow[]>(initialRows);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);

  const reset = useCallback(() => {
    setEnabled(initial.enabled);
    setUrl(initial.url);
    setHttp(initial.http);
    setEmail(initial.email);
    setFormat(initial.format);
    setAppendPath(initial.appendPath);
    setRetry(initial.retry);
    setKeepOrder(initial.keepOrder);
    setSentField(initial.sentField);
    setRows(initialRows);
    setTouched(new Set());
    setSubmitted(false);
  }, [initial, initialRows]);
  useEffect(reset, [reset]);

  const touch = (key: string) =>
    setTouched((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  const shows = (key: string) => submitted || touched.has(key);

  // What the format setting means for this URL.
  const trimmedUrl = url.trim();
  const chatUrl = isChatUrl(trimmedUrl);
  const service = chatServiceName(trimmedUrl);
  const autoFormat: Format = chatUrl ? "chat" : http ? "as_received" : "json";
  const effectiveFormat: Format = format === "auto" ? autoFormat : format;
  const chat = effectiveFormat === "chat";
  const sameAsNotification =
    !!trimmedUrl && !!endpoint.notificationUrl && trimmedUrl === endpoint.notificationUrl.trim();

  // Validation.
  const urlError = (() => {
    if (!trimmedUrl) return enabled ? "Enter a URL." : null;
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
      return null;
    } catch {
      return "Use an https URL on a public host. localhost, private networks and IP addresses cannot be reached from here.";
    }
  })();
  const kindsError = !http && !email ? "Pick at least one." : null;
  const sentFieldError = sentField.trim() ? checkSentField(sentField.trim()) : null;
  const rowIssues = useMemo(
    () => new Map(rows.map((row, index) => [row.id, rowIssue(row, index, rows)] as const)),
    [rows]
  );
  const liveRows = rows.filter((row) => !isEmptyRow(row));
  const tooMany = liveRows.length > MAX_OWNER_HEADERS;
  const invalidCount =
    (urlError ? 1 : 0) +
    (kindsError ? 1 : 0) +
    (sentFieldError ? 1 : 0) +
    (tooMany ? 1 : 0) +
    [...rowIssues.values()].reduce(
      (count, issue) => count + (issue?.name ? 1 : 0) + (issue?.value ? 1 : 0),
      0
    );

  // Dirty state and the footer's hint.
  const changes = {
    enabled: enabled !== initial.enabled,
    url: trimmedUrl !== initial.url,
    kinds: http !== initial.http || email !== initial.email,
    format: format !== initial.format,
    headers: serializeRows(rows) !== serializeRows(initialRows),
    advanced:
      appendPath !== initial.appendPath ||
      retry !== initial.retry ||
      keepOrder !== initial.keepOrder ||
      sentField.trim() !== initial.sentField,
  };
  const dirty = Object.values(changes).some(Boolean);

  const { summary } = useDeliverySummary(
    endpoint.slug,
    endpoint.id,
    onScreen && documentVisible && !!initial.url && endpoint.hasForwardSecret === true
  );
  const pending = summary?.pending ?? 0;
  const hint = (() => {
    const changed = Object.entries(changes)
      .filter(([, value]) => value)
      .map(([key]) => key);
    if (changed.length === 1 || (changed.length === 2 && changes.url && changes.kinds)) {
      if (changes.enabled) {
        if (enabled) return "Forwarding turned on.";
        return pending > 0
          ? `Forwarding turned off. The ${pending} ${pending === 1 ? "delivery" : "deliveries"} still retrying will be marked failed.`
          : "Forwarding turned off.";
      }
      if (changes.url && changes.kinds) return "URL and what to forward changed.";
      if (changes.url) return "URL changed.";
      if (changes.kinds) {
        const kindOff = (initial.http && !http) || (initial.email && !email);
        return kindOff && pending > 0
          ? "What to forward changed. Deliveries of that kind still retrying will be marked failed."
          : "What to forward changed.";
      }
      if (changes.format) return "Format changed.";
      if (changes.headers) return "Headers changed.";
      if (changes.advanced) return "Advanced options changed.";
    }
    return "Forwarding changed.";
  })();

  const onSave = () => {
    setSubmitted(true);
    void save(
      {
        ...(changes.enabled ? { forwardEnabled: enabled } : {}),
        ...(changes.url ? { forwardUrl: trimmedUrl || null } : {}),
        ...(http !== initial.http ? { forwardHttp: http } : {}),
        ...(email !== initial.email ? { forwardEmail: email } : {}),
        ...(changes.format ? { forwardFormat: format } : {}),
        ...(changes.headers
          ? {
              forwardHeaders: liveRows.map((row) => ({
                name: row.name.trim(),
                value: row.value,
              })),
            }
          : {}),
        ...(appendPath !== initial.appendPath ? { forwardAppendPath: appendPath } : {}),
        ...(retry !== initial.retry ? { forwardRetrySeconds: retry } : {}),
        ...(keepOrder !== initial.keepOrder ? { forwardKeepOrder: keepOrder } : {}),
        ...(sentField.trim() !== initial.sentField
          ? { forwardSentField: sentField.trim() || null }
          : {}),
      },
      () => {
        if (invalidCount === 1 && urlError === "Enter a URL.") throw new Error("Enter a URL.");
        if (invalidCount > 0) {
          throw new Error(
            invalidCount === 1
              ? "Fix the field marked above."
              : `Fix the ${invalidCount} fields marked above.`
          );
        }
      }
    ).then((ok) => ok && setSubmitted(false));
  };

  // Header rows: focus follows additions and removals; a live region says what changed.
  const nameRefs = useRef(new Map<number, HTMLInputElement | null>());
  const addRef = useRef<HTMLButtonElement>(null);
  const focusName = (id: number | null) => {
    requestAnimationFrame(() => {
      if (id !== null) nameRefs.current.get(id)?.focus();
      else addRef.current?.focus();
    });
  };
  const addRow = () => {
    const id = nextRowId++;
    setRows((prev) => [...prev, { id, name: "", storedName: null, value: "", masked: null }]);
    setAnnounce("Header added");
    focusName(id);
  };
  const removeRow = (index: number) => {
    const row = rows[index];
    const next = rows[index + 1];
    setRows((prev) => prev.filter((_, i) => i !== index));
    setAnnounce(`${row.name.trim() || "Header"} removed`);
    focusName(next ? next.id : null);
  };
  const updateRow = (id: number, patch: Partial<HeaderRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  // The secret: hidden until asked for, and never kept after the section unmounts.
  const [secret, setSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const reveal = async () => {
    if (!accessToken) return;
    try {
      setSecret(await fetchForwardSecret(accessToken, endpoint.slug));
      setSecretError(null);
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "The secret could not be loaded.");
    }
  };
  const rotate = async () => {
    if (!accessToken) return;
    try {
      setSecret(await rotateForwardSecret(accessToken, endpoint.slug));
      setSecretError(null);
      setConfirmRotate(false);
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "The secret could not be replaced.");
    }
  };
  const copySecret = async () => {
    try {
      const value =
        secret ?? (accessToken ? await fetchForwardSecret(accessToken, endpoint.slug) : null);
      if (value && (await copyToClipboard(value))) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : "The secret could not be copied.");
    }
  };

  // The test delivery.
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ForwardTestResult | { error: string } | null>(null);
  const sendTest = async () => {
    if (!accessToken || testing) return;
    setTesting(true);
    try {
      setTest(await sendForwardTest(accessToken, endpoint.slug));
    } catch (err) {
      setTest({ error: err instanceof Error ? err.message : "The test delivery failed." });
    } finally {
      setTesting(false);
    }
  };

  // Copy that depends on the state.
  const kindsWord = http && email ? "HTTP request and email" : http ? "HTTP request" : "email";
  const switchHelp = !initial.url
    ? "Add the URL below and save. Forwarding can be turned on once a test delivery has gone through."
    : enabled
      ? !http && !email
        ? "On, but nothing is forwarded until at least one kind is picked below."
        : `On. Every ${kindsWord} captured here is ${chat ? "posted to the channel below" : "sent to the URL below"}.`
      : "Off. Requests captured while off are not forwarded later.";

  const provenance =
    format === "auto" ? (
      chatUrl ? (
        `Picked from the URL: a ${service === "Discord" ? "Discord webhook" : "Slack incoming webhook"}.`
      ) : http ? (
        "Picked from the URL: a server URL, so HTTP requests are relayed as they came."
      ) : (
        "Picked from the URL: a server URL, and only emails are forwarded."
      )
    ) : (
      <>
        Picked by you.{" "}
        <button
          type="button"
          onClick={() => setFormat("auto")}
          className="underline underline-offset-2 text-foreground cursor-pointer"
        >
          Use the URL&apos;s pick ({FORMAT_OPTIONS.find((o) => o.value === autoFormat)?.label})
        </button>
      </>
    );
  const formatDescription =
    effectiveFormat === "as_received"
      ? `The request is relayed as it arrived: same method, headers and body bytes, so the sender's own signature (Stripe, GitHub, ...) still verifies on your server.${email ? " Emails have no request to relay and are sent as signed JSON." : ""}`
      : effectiveFormat === "json"
        ? "A JSON envelope with the request or email inside, signed with Standard Webhooks headers. One handler for both kinds."
        : "The message notifications send: the endpoint, method and path, when it was received, and up to 3,000 characters of the body in a code block.";
  const formatWarning =
    chatUrl && !chat
      ? `${service} expects a chat message. ${effectiveFormat === "as_received" ? "An as-received relay" : "A JSON envelope"} will be rejected by this URL.`
      : null;

  const baseHost = WEBHOOK_BASE_URL.replace(/^https?:\/\//, "");
  const exampleUrl = `${(trimmedUrl || "https://api.example.com/hooks/inbound").replace(/\/+$/, "")}/stripe/events`;
  const summaryParts: { text: string; bold: boolean }[] = [
    ...(chat
      ? []
      : [{ text: appendPath ? "path appended" : "path not appended", bold: !appendPath }]),
    { text: describeRetryWindow(retry), bold: retry !== 86400 },
    { text: keepOrder ? "one at a time" : "up to two at a time", bold: keepOrder },
    ...(sentField.trim() ? [{ text: `sent time from ${sentField.trim()}`, bold: true }] : []),
  ];

  const canTest = !!initial.url && endpoint.hasForwardSecret === true;
  const showHealth = canTest && summary !== null && (summary.total > 0 || initial.enabled);

  return (
    <Section
      id="forwarding"
      sectionRef={sectionRef}
      title="Forwarding"
      description="Send every request this endpoint captures on to your server or a chat channel. Each one is queued, delivered within seconds, retried if it is not accepted, and logged."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint={hint}
          onReset={() => {
            reset();
            setError(null);
            setSaved(false);
          }}
          onSave={onSave}
        />
      }
    >
      <SwitchRow
        id="settings-forward-enabled"
        label="Forward captured requests"
        help={switchHelp}
        checked={enabled}
        onChange={setEnabled}
        disabled={!initial.url}
      />

      <Field
        id="settings-forward-url"
        label="Send to"
        help="An https URL on a public host, or a Slack or Discord incoming webhook."
        error={shows("url") ? urlError : null}
        errorId="settings-forward-url-error"
      >
        <input
          id="settings-forward-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => touch("url")}
          placeholder="https://api.example.com/hooks/inbound"
          aria-invalid={shows("url") && !!urlError}
          aria-describedby={shows("url") && urlError ? "settings-forward-url-error" : undefined}
          className={cn(
            "ui-input w-full text-sm font-mono py-2!",
            shows("url") && urlError && "border-destructive!"
          )}
        />
      </Field>

      <Field
        label="Forward"
        labelId="settings-forward-kinds-label"
        help="What is sent on from the moment forwarding is on. Requests already captured are not sent."
        error={shows("kinds") ? kindsError : null}
        errorId="settings-forward-kinds-error"
      >
        <div
          role="group"
          aria-labelledby="settings-forward-kinds-label"
          aria-describedby={
            shows("kinds") && kindsError ? "settings-forward-kinds-error" : undefined
          }
          className="flex flex-wrap items-center gap-x-5 gap-y-2"
        >
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={http}
              onChange={(e) => {
                setHttp(e.target.checked);
                touch("kinds");
              }}
              className="accent-foreground"
            />
            HTTP requests
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={email}
              onChange={(e) => {
                setEmail(e.target.checked);
                touch("kinds");
              }}
              className="accent-foreground"
            />
            Emails
          </label>
        </div>
      </Field>

      {trimmedUrl && (
        <Field
          label="Format"
          labelId="settings-forward-format-label"
          help={
            <>
              <p>{provenance}</p>
              <p className="max-w-[62ch]">{formatDescription}</p>
              {formatWarning && <p className="text-destructive">{formatWarning}</p>}
            </>
          }
        >
          <Segmented
            name="Format"
            value={effectiveFormat}
            onChange={setFormat}
            options={FORMAT_OPTIONS}
          />
        </Field>
      )}

      {trimmedUrl && chat && (
        <div className="pt-4 border-t border-line/20">
          {sameAsNotification ? (
            <p className="text-xs text-destructive max-w-[62ch]">
              This is also the notification URL, so the channel gets requests twice. Keep one of the
              two.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground max-w-[62ch]">
              Every captured request is posted, retried and logged. For a lighter heads-up (at most
              one message per second, not retried), use{" "}
              <a
                href="#settings-notifications"
                className="underline underline-offset-2 text-foreground"
              >
                Notifications
              </a>{" "}
              instead.
            </p>
          )}
        </div>
      )}

      {trimmedUrl && !chat && (
        <>
          <div className="pt-4 border-t border-line/20 space-y-1.5">
            <span id="settings-forward-headers-label" className="block text-xs font-bold caps">
              Headers
            </span>
            <p className="text-xs text-muted-foreground max-w-[62ch]">
              Sent with every delivery, for example a token your server expects. Values are stored
              encrypted and hidden after saving.
            </p>
            {rows.length > 0 && (
              <div aria-labelledby="settings-forward-headers-label" className="space-y-2 pt-1">
                {rows.map((row, index) => {
                  const n = index + 1;
                  const issue = rowIssues.get(row.id) ?? null;
                  const nameShown = shows(`h${row.id}n`) && !!issue?.name;
                  const valueShown = shows(`h${row.id}v`) && !!issue?.value;
                  const nameErrorId = `settings-forward-header-${row.id}-name-error`;
                  const valueErrorId = `settings-forward-header-${row.id}-value-error`;
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
                        onKeyDown={(e) => {
                          if (e.key === "Backspace" && isEmptyRow(row) && row.name === "") {
                            e.preventDefault();
                            const previous = rows[index - 1];
                            setRows((prev) => prev.filter((r) => r.id !== row.id));
                            setAnnounce("Header removed");
                            focusName(previous ? previous.id : null);
                          }
                        }}
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
            <div className="flex flex-wrap items-center gap-3 pt-1">
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
                <span
                  className={cn("text-xs", tooMany ? "text-destructive" : "text-muted-foreground")}
                >
                  Headers are limited to {MAX_OWNER_HEADERS}.
                </span>
              )}
              <span role="status" aria-live="polite" className="sr-only">
                {announce}
              </span>
            </div>
          </div>

          <div className="pt-4 border-t border-line/20 space-y-1.5">
            <span className="block text-xs font-bold caps">Always added</span>
            <HeaderCode
              rows={effectiveFormat === "as_received" ? RELAY_HEADERS : JSON_HEADERS}
              slug={endpoint.slug}
            />
            <p className="text-xs text-muted-foreground max-w-[62ch]">
              {effectiveFormat === "as_received" ? (
                "Five headers on every as-received delivery, so your server can tell a relay from the original, measure the delay, and check it came from here. The body is never changed."
              ) : (
                <>
                  The Standard Webhooks headers on every signed JSON delivery. Every copy of one
                  request carries the same <code className="font-mono">webhook-id</code>, so a
                  handler that saw it before can skip it.
                </>
              )}
            </p>
          </div>

          <div className="pt-4 border-t border-line/20">
            <Field
              label="Signing secret"
              help={
                endpoint.hasForwardSecret ? (
                  effectiveFormat === "as_received" ? (
                    <p>
                      Check the <code className="font-mono">webhooks-cc-signature</code> header with
                      it on relayed requests
                      {email && (
                        <>
                          , and <code className="font-mono">webhook-signature</code> on emails
                        </>
                      )}
                      .{" "}
                      <Link href={RELAY_VERIFY_DOC} className="underline underline-offset-2">
                        How to verify
                      </Link>
                    </p>
                  ) : (
                    <p>
                      Check the <code className="font-mono">webhook-signature</code> header with it
                      (Standard Webhooks).{" "}
                      <Link href={JSON_VERIFY_DOC} className="underline underline-offset-2">
                        How to verify
                      </Link>
                    </p>
                  )
                ) : undefined
              }
            >
              {endpoint.hasForwardSecret ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="ui-input flex-1 min-w-[220px] text-sm font-mono py-2! truncate">
                      {secret ?? "whsec_" + "•".repeat(24)}
                    </code>
                    <button
                      type="button"
                      onClick={() => (secret ? setSecret(null) : void reveal())}
                      className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
                    >
                      {secret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {secret ? "Hide" : "Reveal"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copySecret()}
                      className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
                    >
                      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    {confirmRotate ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void rotate()}
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
                  {confirmRotate && (
                    <p className="text-xs text-muted-foreground">
                      Deliveries are signed with the new secret at once, so your server needs it
                      before it can verify them again.
                    </p>
                  )}
                  {secretError && <p className="text-xs text-destructive">{secretError}</p>}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Created when you save. Your server checks each delivery with it.
                </p>
              )}
            </Field>
          </div>
        </>
      )}

      {trimmedUrl && (
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          className="pt-4 border-t border-line/20 group"
        >
          <summary className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1 text-xs font-bold caps">
              <ChevronRight className="h-3 w-3 transition-transform motion-reduce:transition-none group-open:rotate-90" />
              Advanced
            </span>
            <span className="text-xs text-muted-foreground">
              {summaryParts.map((part, index) => {
                const text =
                  index === 0 ? part.text.charAt(0).toUpperCase() + part.text.slice(1) : part.text;
                return (
                  <span key={part.text}>
                    {index > 0 && ", "}
                    {part.bold ? <b className="font-semibold text-foreground">{text}</b> : text}
                  </span>
                );
              })}
              .
            </span>
          </summary>
          <div className="pt-4 space-y-4">
            {!chat && (
              <SwitchRow
                id="settings-forward-append-path"
                label="Append the request path"
                checked={appendPath}
                onChange={setAppendPath}
                help={
                  appendPath ? (
                    <>
                      The path after the slug is added to the URL.{" "}
                      <code className="font-mono">
                        {baseHost}/w/{endpoint.slug}/stripe/events
                      </code>{" "}
                      is delivered to <code className="font-mono">{exampleUrl}</code>. Emails are
                      not affected.
                    </>
                  ) : (
                    <>
                      Off: every request is delivered to the URL exactly as written. Turn on to add
                      the path after the slug, so <code className="font-mono">/stripe/events</code>{" "}
                      reaches <code className="font-mono">{exampleUrl}</code>.
                    </>
                  )
                }
              />
            )}
            <Field
              label="Retry failed deliveries"
              help={
                retry === 0
                  ? "One try per delivery. A failure shows in the delivery log and can be redelivered by hand."
                  : retry === 3600
                    ? "After a failed try: 30 s, 2 min, 10 min and 30 min later, then marked failed."
                    : "After a failed try: 30 s, 2 min, 10 min, 30 min and 1 h later, then 3 h, 6 h and 12 h, then marked failed."
              }
            >
              <Segmented
                name="Retry failed deliveries"
                value={`${retry}` as `${Retry}`}
                onChange={(next) => setRetry(Number(next) as Retry)}
                options={RETRY_OPTIONS}
              />
            </Field>
            <SwitchRow
              id="settings-forward-keep-order"
              label="Keep order"
              checked={keepOrder}
              onChange={setKeepOrder}
              help={
                keepOrder
                  ? "One delivery at a time, in the order captured. A slow answer from your server holds the rest back."
                  : "Off: up to two deliveries at a time, so a slow answer does not hold the rest back, but two may overtake each other."
              }
            />
            <Field
              id="settings-forward-sent-field"
              label="Sent time field"
              help="A field in the JSON body that holds when the sender sent the request, for example publishedAt. Use dots for nested fields, as in data.publishedAt. The deliveries then show how long each request took to reach webhooks.cc, and chat messages say it too. Without one, standard timestamp headers are read where a sender has them (Standard Webhooks, Stripe)."
              error={shows("sent") ? sentFieldError : null}
              errorId="settings-forward-sent-field-error"
            >
              <input
                id="settings-forward-sent-field"
                value={sentField}
                onChange={(e) => setSentField(e.target.value)}
                onBlur={() => touch("sent")}
                placeholder="publishedAt"
                aria-invalid={shows("sent") && !!sentFieldError}
                aria-describedby={
                  shows("sent") && sentFieldError ? "settings-forward-sent-field-error" : undefined
                }
                className={cn(
                  "ui-input w-full text-sm font-mono py-2!",
                  shows("sent") && sentFieldError && "border-destructive!"
                )}
              />
            </Field>
          </div>
        </details>
      )}

      {canTest && (
        <div className="space-y-2 pt-4 border-t border-line/20">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={testing || dirty}
              className={cn(
                "ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5",
                (testing || dirty) && "opacity-50 cursor-not-allowed"
              )}
            >
              <Send className="h-3 w-3" />
              {testing ? "Sending..." : "Send test delivery"}
            </button>
            <span className="text-xs text-muted-foreground">
              {dirty
                ? "Save first: the test uses the saved settings."
                : chat
                  ? "Posts the newest captured request (or a sample) to the channel now, once."
                  : "Sends the newest captured request (or a sample) to the URL above now, once."}
            </span>
          </div>
          <div role="status" aria-live="polite" className="text-sm space-y-2">
            {test && "delivered" in test ? (
              <TestResult test={test} />
            ) : test ? (
              <p className="text-destructive">{test.error}</p>
            ) : null}
          </div>
        </div>
      )}

      {showHealth && summary && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 pt-4 border-t border-line/20 text-[13px]"
        >
          <span className="text-muted-foreground">Last 24 h</span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="delivered" />
            <span className="font-mono font-semibold">
              {formatCappedCount(summary.last24h.delivered)}
            </span>{" "}
            delivered
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="retrying" />
            <span className="font-mono font-semibold">
              {formatCappedCount(summary.pending)}
            </span>{" "}
            retrying
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="failed" />
            <span className="font-mono font-semibold">
              {formatCappedCount(summary.last24h.failed)}
            </span>{" "}
            failed
          </span>
          <button
            type="button"
            onClick={onSeeDeliveries}
            className="text-xs underline underline-offset-2 cursor-pointer"
          >
            See deliveries
          </button>
        </div>
      )}
    </Section>
  );
}
