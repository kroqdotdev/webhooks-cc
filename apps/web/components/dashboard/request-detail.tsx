"use client";

import { useState, useRef, useEffect, useCallback, useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  Copy,
  Check,
  ChevronDown,
  Download,
  Send,
  Settings,
  Link as LinkIcon,
  StickyNote,
  X,
} from "lucide-react";
import { ReplayDialog } from "./replay-dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { formatBytes, formatFullTimestamp } from "@/types/request";
import { hexDump, requestBodyBytes } from "@/lib/body-bytes";
import type { Request, ClickHouseRequest } from "@/types/request";
import { WEBHOOK_BASE_URL, SKIP_HEADERS_FOR_CURL } from "@/lib/constants";
import { detectFormat, formatBody, getFormatLabel } from "@/lib/format";
import { getHighlightLanguage, highlightBody } from "@/lib/highlight";
import { trackRequestViewed, trackRequestDetailTabChanged } from "@/lib/analytics";
import { generatePayloadSchema, payloadSample } from "@webhooks-cc/sdk/schema";
import { hasSchemaSample, schemaRootName, type SchemaSource } from "@/lib/payload-schema";
import { JsonTree } from "./json-tree";
import { SignatureTab, SignatureVerificationBadge } from "./signature-tab";
import { ProviderBadge } from "./provider-badge";
import { DeliveriesPane, type DeliveryEndpoint } from "./delivery-pane";
import { PayloadSchemaView } from "./payload-schema-view";
import { ShareRequestDialog } from "./share-request-dialog";
import { ResponseAnswer } from "./response-answer";

/** Any request shape that has the fields needed for display. */
export type DisplayableRequest = Request | ClickHouseRequest;

/** Props for RequestDetail component. */
interface RequestDetailProps {
  /** The captured webhook request to display. */
  request: DisplayableRequest;
  /** Current active tab (controlled). */
  activeTab?: Tab;
  /** Callback when tab changes. */
  onTabChange?: (tab: Tab) => void;
  /** Ref forwarded to the cURL copy button (for keyboard shortcuts). */
  curlBtnRef?: React.RefObject<HTMLButtonElement | null>;
  /** Persisted note for this request. */
  note?: string | null;
  /** Callback when note changes. */
  onNoteChange?: (note: string) => void;
  /** Callback to open endpoint settings (for the "Save to endpoint settings" link). */
  onOpenSettings?: () => void;
  /** Slug of the endpoint this request belongs to (used to prefill the manual-verify URL). */
  endpointSlug?: string;
  /** Shows the Deliveries tab: the endpoint's forwarding, and whether this user may redeliver. */
  deliveries?: {
    endpoint: DeliveryEndpoint;
    canRedeliver: boolean;
    onOpenForwarding?: () => void;
  };
  /** Recent requests the schema view looks through for ones with the same payload. */
  schemaCandidates?: SchemaSource[];
  /** Shows the Share button, for a signed-in user (share links take a session). */
  share?: { accessToken: string };
}

/**
 * Escapes a string for use inside shell double quotes.
 * In double-quoted strings, bash interprets: \ " ` $ and newlines.
 * This escapes those characters to prevent shell injection in curl commands.
 *
 * Note: Newlines and carriage returns are replaced with literal \n and \r
 * for display purposes. The curl command will send these as literals, not
 * as control characters. For exact reproduction of bodies with newlines,
 * users should use the Replay feature instead.
 */
/**
 * Whether a horizontally scrolling element has more content past its right
 * edge: a tab strip fades there only then, at any width.
 */
export function useMoreToRight<T extends HTMLElement>() {
  const [more, setMore] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const update = () =>
      setMore(element.scrollWidth - element.clientWidth - element.scrollLeft > 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", update, { passive: true });
    update();
    cleanup.current = () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  return [ref, more] as const;
}

function escapeForShellDoubleQuotes(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Escapes a string for use inside shell single quotes.
 * Single-quoted strings interpret nothing except the quote itself.
 * To include a literal quote: end the string, add escaped quote, restart: 'foo'\''bar'
 */
function escapeForShellSingleQuotes(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/** Valid HTTP methods - alphanumeric only to prevent shell injection */
const VALID_HTTP_METHOD = /^[A-Z]+$/;

/**
 * Generates a curl command that reproduces the captured request.
 * Skips host (set by curl), content-length (calculated by curl),
 * and connection (managed by curl) headers to avoid conflicts.
 */
function generateCurlCommand(request: DisplayableRequest): string {
  // Validate method is alphanumeric to prevent shell injection
  const safeMethod = VALID_HTTP_METHOD.test(request.method) ? request.method : "GET";
  const parts = [`curl -X ${safeMethod}`];
  for (const [key, value] of Object.entries(request.headers)) {
    if (!SKIP_HEADERS_FOR_CURL.includes(key.toLowerCase())) {
      const safeKey = escapeForShellDoubleQuotes(key);
      const safeValue = escapeForShellDoubleQuotes(value);
      parts.push(`-H "${safeKey}: ${safeValue}"`);
    }
  }
  if (request.body) {
    parts.push(`-d '${escapeForShellSingleQuotes(request.body)}'`);
  }
  // Ensure path starts with / and normalize
  const normalizedPath = request.path.startsWith("/") ? request.path : `/${request.path}`;
  let url = `${WEBHOOK_BASE_URL}${normalizedPath}`;
  const queryString = new URLSearchParams(request.queryParams).toString();
  if (queryString) url += `?${queryString}`;
  parts.push(`"${escapeForShellDoubleQuotes(url)}"`);
  return parts.join(" \\\n  ");
}

type BodyView = "tree" | "formatted" | "schema";
const BODY_VIEWS: BodyView[] = ["tree", "formatted", "schema"];
const BODY_VIEW_LABELS: Record<BodyView, string> = {
  tree: "Tree",
  formatted: "Formatted",
  schema: "Schema",
};

export type Tab = "body" | "headers" | "query" | "raw" | "signature" | "deliveries";
export const TABS: Tab[] = ["body", "headers", "query", "raw", "signature", "deliveries"];

export function RequestDetail({
  request,
  activeTab,
  onTabChange,
  curlBtnRef,
  note,
  onNoteChange,
  onOpenSettings,
  endpointSlug,
  deliveries,
  schemaCandidates,
  share,
}: RequestDetailProps) {
  const [internalTab, setInternalTab] = useState<Tab>("body");
  const setTab = onTabChange ?? setInternalTab;
  // The Deliveries tab exists once the endpoint has (or had) a forwarding URL.
  const tabs = deliveries ? TABS : TABS.filter((entry) => entry !== "deliveries");
  const requested = activeTab ?? internalTab;
  const tab = tabs.includes(requested) ? requested : "body";

  const [copied, setCopied] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = "id" in request ? request.id : request._id;

  useEffect(() => {
    trackRequestViewed(request.method);
  }, [requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async (text: string, key: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(key);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setCopied(null), 2000);
    }
  }, []);

  const tabCounts = {
    headers: Object.keys(request.headers).length,
    query: Object.keys(request.queryParams).length,
  };
  const curlCommand = useMemo(() => generateCurlCommand(request), [request]);
  const fullTime = formatFullTimestamp(request.receivedAt);
  // The exact bytes when the body was not UTF-8 (body_raw); shown as hex and replayed as is.
  // An octet-stream body that was valid UTF-8 is kept as text, so it reads as text.
  const isBinary = !!request.bodyRaw;
  const declaredFormat = detectFormat(request.contentType, request.body);
  const bodyFormat = declaredFormat === "binary" && !isBinary ? "text" : declaredFormat;
  const bodyBytes = useMemo(
    () => (isBinary ? requestBodyBytes(request) : null),
    [isBinary, request]
  );
  const formattedBody = useMemo(
    () => (request.body ? formatBody(request.body, bodyFormat) : "(empty body)"),
    [request.body, bodyFormat]
  );
  const highlightedBody = useMemo(
    () => highlightBody(formattedBody, bodyFormat),
    [formattedBody, bodyFormat]
  );
  const highlightLanguage = getHighlightLanguage(bodyFormat);
  const schemaAvailable = useMemo(() => hasSchemaSample(request), [request]);
  const tsInterface = useMemo(() => {
    const sample = schemaAvailable ? payloadSample(request) : undefined;
    return sample === undefined
      ? null
      : generatePayloadSchema([sample], { name: schemaRootName(request) });
  }, [request, schemaAvailable]);

  // JSON tree view: parse once, show tree or formatted view
  const parsedJson = useMemo(() => {
    if (bodyFormat !== "json" || !request.body) return null;
    try {
      return JSON.parse(request.body) as unknown;
    } catch {
      return null;
    }
  }, [request.body, bodyFormat]);
  const [bodyViewChoice, setBodyView] = useState<BodyView>("tree");
  const bodyViews = BODY_VIEWS.filter(
    (view) => (view !== "tree" || parsedJson !== null) && (view !== "schema" || schemaAvailable)
  );
  const bodyView = bodyViews.includes(bodyViewChoice) ? bodyViewChoice : "formatted";

  // On a phone the tab strip scrolls; keep the active tab in view (clear of the
  // fade) without moving the page itself, which scrollIntoView could do.
  // The desktop and phone panes can both render this view, so ids are per instance.
  const tabIds = useId();
  const tablistRef = useRef<HTMLDivElement>(null);
  const [tabStripMoreRef, tabStripMore] = useMoreToRight<HTMLDivElement>();
  const tabStripRef = useCallback(
    (element: HTMLDivElement | null) => {
      tablistRef.current = element;
      tabStripMoreRef(element);
    },
    [tabStripMoreRef]
  );
  useEffect(() => {
    const list = tablistRef.current;
    const active = list?.querySelector<HTMLElement>(`[role="tab"][data-tab="${tab}"]`);
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const listBox = list.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    const fade = 32;
    if (box.left < listBox.left) list.scrollLeft += box.left - listBox.left;
    else if (box.right > listBox.right - fade) {
      list.scrollLeft += Math.min(box.right - listBox.right + fade, box.left - listBox.left);
    }
  }, [tab]);

  return (
    <div className="ph-no-capture flex flex-col h-full">
      {/* Summary bar */}
      {/* Sized by the pane, not the window: beside the list the pane can be narrow. */}
      <div className="@container border-b-strong border-line px-4 py-3 shrink-0">
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-4">
          <div className="min-w-0">
            <div className="font-mono font-bold text-sm break-all @xl:truncate">
              {request.method} {request.path}
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-0.5 flex items-center gap-3 flex-wrap">
              {request.detectedProvider && <ProviderBadge provider={request.detectedProvider} />}
              {request.detectedEvent && (
                <span className="min-w-0 max-w-full truncate">{request.detectedEvent}</span>
              )}
              {request.ip && <span>{request.ip}</span>}
              <span>{formatBytes(request.size)}</span>
              <span>{fullTime}</span>
              {request.signatureVerified != null && (
                <SignatureVerificationBadge
                  signatureVerified={request.signatureVerified}
                  signatureError={request.signatureError}
                  signingProvider={request.signingProvider}
                  onClick={() => setTab("signature")}
                />
              )}
              <ResponseAnswer request={request} />
            </div>
          </div>
          {/* On phones every action is at least 36px tall (Share and Replay render their own buttons). */}
          <div className="flex items-center gap-2 shrink-0 max-md:[&_button]:min-h-9">
            <button
              ref={curlBtnRef}
              onClick={() => handleCopy(curlCommand, "curl")}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              {copied === "curl" ? (
                <>
                  <Check className="h-3 w-3" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  cURL
                </>
              )}
            </button>
            {share && request.kind !== "email" && (
              <ShareRequestDialog
                requestId={requestId}
                headers={request.headers}
                queryParams={request.queryParams}
                accessToken={share.accessToken}
              />
            )}
            <ReplayDialog
              method={request.method}
              headers={request.headers}
              body={request.body}
              bodyBytes={bodyBytes ?? undefined}
            />
          </div>
        </div>
      </div>

      {/* Note bar */}
      {onNoteChange && <NoteBar note={note ?? null} onChange={onNoteChange} />}

      {/* Tabs. The strip scrolls when the tabs do not fit; a fade on the right says there is more. */}
      <div className="shrink-0 border-b-strong border-line">
        <div
          ref={tabStripRef}
          className={cn(
            "flex overflow-x-auto [scrollbar-width:none]",
            tabStripMore &&
              "[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)]"
          )}
        >
          <div role="tablist" aria-label="Request sections" className="flex shrink-0">
            {tabs.map((t, index) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`${tabIds}-tab-${t}`}
                data-tab={t}
                aria-selected={tab === t}
                aria-controls={`${tabIds}-panel`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => {
                  if (tab === t) return;
                  setTab(t);
                  trackRequestDetailTabChanged(t);
                }}
                onKeyDown={(event) => {
                  // Arrow keys move between tabs, as in any tab list.
                  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = tabs[(index + step + tabs.length) % tabs.length];
                  setTab(next);
                  trackRequestDetailTabChanged(next);
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                    ?.focus();
                }}
                className={cn(
                  "px-4 py-2 text-xs font-bold caps clean:capitalize border-r-strong border-line last:border-r-0 cursor-pointer transition-colors whitespace-nowrap",
                  // Clean's tint alone is too faint, so the active tab also gets a primary underline.
                  tab === t
                    ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                    : "bg-background hover:bg-muted"
                )}
              >
                {t}
                {(t === "headers" || t === "query") && (
                  <>
                    <span className="sr-only">, </span>
                    <span className="ml-1.5 font-mono opacity-70">{tabCounts[t]}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div
        role="tabpanel"
        id={`${tabIds}-panel`}
        aria-labelledby={`${tabIds}-tab-${tab}`}
        className="flex-1 overflow-auto p-4"
      >
        {tab === "body" && (
          <div className="relative">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-mono font-bold caps text-muted-foreground">
                {getFormatLabel(bodyFormat)}
              </span>
              {bodyViews.length > 1 && (
                <div className="flex items-center overflow-hidden rounded-sm border-strong border-line">
                  {bodyViews.map((view, i) => (
                    <button
                      key={view}
                      type="button"
                      aria-pressed={bodyView === view}
                      onClick={() => setBodyView(view)}
                      className={cn(
                        "px-2.5 py-1 max-md:py-1.5 text-[11px] font-bold caps cursor-pointer transition-colors",
                        i > 0 && "border-l-strong border-line",
                        bodyView === view
                          ? "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                          : "hover:bg-muted"
                      )}
                    >
                      {BODY_VIEW_LABELS[view]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {request.body && bodyView !== "schema" && !bodyBytes && (
              <BodyCopyDropdown
                body={request.body}
                formattedBody={formattedBody}
                tsInterface={tsInterface}
                onCopy={handleCopy}
                copied={copied}
              />
            )}
            {bodyBytes ? (
              <BinaryBody bytes={bodyBytes} id={requestId} />
            ) : bodyView === "schema" ? (
              <PayloadSchemaView
                request={request}
                candidates={schemaCandidates}
                onCopy={handleCopy}
                copied={copied}
              />
            ) : parsedJson !== null && bodyView === "tree" ? (
              <div className="ui-code overflow-x-auto p-3">
                <JsonTree data={parsedJson} />
              </div>
            ) : (
              <pre className="ui-code syntax-highlight overflow-x-auto text-sm whitespace-pre-wrap break-words">
                {/* Safe: highlightBody escapes plain/form/text/binary output and Prism.highlight encodes token text for json/xml. */}
                <code
                  className={`language-${highlightLanguage}`}
                  dangerouslySetInnerHTML={{ __html: highlightedBody }}
                />
              </pre>
            )}
          </div>
        )}

        {tab === "headers" && (
          <div className="ui-code overflow-x-auto">
            <table className="text-sm font-mono w-full">
              <tbody>
                {Object.entries(request.headers).map(([key, value]) => (
                  <tr key={key} className="border-b border-foreground/20 last:border-0">
                    <td className="w-px pr-6 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                      {key}
                    </td>
                    <td className="py-1.5 break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "query" && (
          <div>
            {Object.keys(request.queryParams).length > 0 ? (
              <div className="ui-code overflow-x-auto">
                <table className="text-sm font-mono w-full">
                  <tbody>
                    {Object.entries(request.queryParams).map(([key, value]) => (
                      <tr key={key} className="border-b border-foreground/20 last:border-0">
                        <td className="w-px pr-6 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                          {key}
                        </td>
                        <td className="py-1.5 break-all">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">This request had no query string.</p>
            )}
          </div>
        )}

        {tab === "raw" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Raw body, {formatBytes(request.size)}
              </span>
              {request.body && (
                <button
                  type="button"
                  onClick={() => handleCopy(request.body ?? "", "raw")}
                  className="ui-btn-outline py-1! max-md:min-h-9 px-2.5! text-xs flex items-center gap-1.5"
                >
                  {copied === "raw" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied === "raw" ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <pre className="ui-code overflow-x-auto text-sm whitespace-pre-wrap break-all">
              {request.body || "(empty body)"}
            </pre>
          </div>
        )}

        {tab === "signature" && (
          <SignatureTab
            request={request}
            onOpenSettings={onOpenSettings}
            endpointSlug={endpointSlug}
          />
        )}

        {tab === "deliveries" && deliveries && (
          <DeliveriesPane
            key={requestId}
            request={request}
            endpoint={deliveries.endpoint}
            canRedeliver={deliveries.canRedeliver}
            onOpenForwarding={deliveries.onOpenForwarding}
          />
        )}
      </div>
    </div>
  );
}

function jsonToCsvValue(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) return null;

  const allKeys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        allKeys.add(key);
      }
    }
  }
  const keys = [...allKeys];
  if (keys.length === 0) return null;

  const escape = (val: unknown): string => {
    const str =
      val === null || val === undefined
        ? ""
        : typeof val === "object"
          ? JSON.stringify(val)
          : String(val);
    return str.includes(",") || str.includes('"') || str.includes("\n")
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };

  const header = keys.map(escape).join(",");
  const lines = rows.map((row) => {
    const obj = (row ?? {}) as Record<string, unknown>;
    return keys.map((k) => escape(obj[k])).join(",");
  });

  return [header, ...lines].join("\n");
}

function BodyCopyDropdown({
  body,
  formattedBody,
  tsInterface,
  onCopy,
  copied,
}: {
  body: string;
  formattedBody: string;
  tsInterface: string | null;
  onCopy: (text: string, key: string) => void;
  copied: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const csvBody = useMemo(() => jsonToCsvValue(body), [body]);
  const isCopied =
    copied === "body" || copied === "body-formatted" || copied === "ts" || copied === "csv";

  const options = useMemo(() => {
    const opts: { key: string; label: string; value: string }[] = [
      { key: "body", label: "Raw body", value: body },
      { key: "body-formatted", label: "Formatted", value: formattedBody },
    ];
    if (tsInterface) {
      opts.push({ key: "ts", label: "TypeScript interface", value: tsInterface });
    }
    if (csvBody) {
      opts.push({ key: "csv", label: "CSV", value: csvBody });
    }
    return opts;
  }, [body, formattedBody, tsInterface, csvBody]);

  return (
    <div className="absolute top-0 right-0" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="ui-btn-outline py-1! max-md:min-h-9 px-2! text-xs flex items-center gap-1"
      >
        {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {isCopied ? "Copied!" : "Copy"}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 overflow-hidden rounded-lg border-strong border-line bg-background shadow-raised z-50 min-w-[180px]">
          {options.map((opt, i) => (
            <button
              key={opt.key}
              onClick={() => {
                onCopy(opt.value, opt.key);
                setOpen(false);
              }}
              className={cn(
                "w-full px-3 py-2 text-left text-xs font-bold caps hover:bg-muted cursor-pointer transition-colors",
                i < options.length - 1 && "border-b-strong border-line"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NoteBar({
  note,
  onChange,
}: {
  note: string | null;
  onChange: (note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setDraft(note ?? "");
  }, [note]);

  useEffect(() => {
    if (editing) {
      cancelledRef.current = false;
      inputRef.current?.focus();
    }
  }, [editing]);

  const save = useCallback(() => {
    if (cancelledRef.current) return;
    onChange(draft);
    setEditing(false);
  }, [draft, onChange]);

  if (!editing && !note) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="border-b-strong border-line px-4 py-1.5 max-md:py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 w-full text-left"
      >
        <StickyNote className="h-3 w-3" />
        Add note...
      </button>
    );
  }

  if (editing) {
    return (
      <div className="border-b-strong border-line px-4 py-1.5 max-md:min-h-9 flex items-center gap-2 shrink-0">
        <StickyNote className="h-3 w-3 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={280}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              e.stopPropagation();
              cancelledRef.current = true;
              setDraft(note ?? "");
              setEditing(false);
            }
          }}
          onBlur={save}
          aria-label="Request note"
          className="flex-1 text-xs bg-transparent outline-none font-mono placeholder:text-muted-foreground min-w-0"
          placeholder="Type a note..."
        />
      </div>
    );
  }

  return (
    <div className="border-b-strong border-line px-4 py-1.5 max-md:py-0 flex items-center gap-2 shrink-0 group">
      <StickyNote className="h-3 w-3 text-muted-foreground shrink-0" />
      <button
        type="button"
        className="flex-1 text-xs font-mono truncate cursor-pointer text-left bg-transparent border-0 p-0 max-md:min-h-9"
        onClick={() => setEditing(true)}
        aria-label="Edit request note"
      >
        {note}
      </button>
      <button
        type="button"
        onClick={() => onChange("")}
        aria-label="Delete request note"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 max-md:size-9 max-md:-mr-2 max-md:inline-flex max-md:items-center max-md:justify-center text-muted-foreground hover:text-foreground transition-opacity cursor-pointer"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

interface RequestDetailEmptyProps {
  slug?: string;
  onSendTest?: () => void;
  onOpenSettings?: () => void;
}

export function RequestDetailEmpty({ slug, onSendTest, onOpenSettings }: RequestDetailEmptyProps) {
  const [copied, setCopied] = useState(false);
  const url = slug ? `${WEBHOOK_BASE_URL}/w/${slug}` : null;

  const handleCopy = async () => {
    if (!url) return;
    const success = await copyToClipboard(url);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Minimal fallback when no slug is passed (shouldn't happen in practice)
  if (!slug) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="font-bold caps text-sm">Select a request to view details</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="max-w-sm w-full space-y-5 text-center">
        <p className="font-bold caps text-sm text-muted-foreground">
          Select a request to view details
        </p>

        {/* Quick actions */}
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {onSendTest && (
            <button
              onClick={onSendTest}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              <Send className="h-3 w-3" />
              Send Test
            </button>
          )}
          {url && (
            <button
              onClick={handleCopy}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              {copied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
              {copied ? "Copied!" : "Copy URL"}
            </button>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              <Settings className="h-3 w-3" />
              Settings
            </button>
          )}
        </div>

        {/* Keyboard hint */}
        <p className="text-[11px] text-muted-foreground caps">
          Press{" "}
          <kbd className="px-1 py-0.5 rounded-sm border border-foreground/30 bg-muted font-mono text-[11px]">
            ?
          </kbd>{" "}
          for keyboard shortcuts
        </p>
      </div>
    </div>
  );
}

const HEX_PREVIEW_BYTES = 512;

/** A binary body: a hex preview of its first bytes and a download of all of them. */
function BinaryBody({ bytes, id }: { bytes: Uint8Array<ArrayBuffer>; id: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `body-${id.slice(0, 8)}.bin`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          Binary body, {formatBytes(bytes.length)}.
          {bytes.length > HEX_PREVIEW_BYTES ? ` Showing the first ${HEX_PREVIEW_BYTES} bytes.` : ""}
        </span>
        <button
          type="button"
          onClick={download}
          className="ui-btn-outline py-1! px-2.5! text-xs flex items-center gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          Download body
        </button>
      </div>
      <pre className="ui-code overflow-x-auto text-xs leading-relaxed">
        {hexDump(bytes, HEX_PREVIEW_BYTES)}
      </pre>
    </div>
  );
}
