"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Code, Send, Settings, Link as LinkIcon } from "lucide-react";
import { ReplayDialog } from "./replay-dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { formatBytes } from "@/types/request";
import type { Request, ClickHouseRequest } from "@/types/request";
import { WEBHOOK_BASE_URL, SKIP_HEADERS_FOR_CURL } from "@/lib/constants";
import { detectFormat, formatBody, getFormatLabel } from "@/lib/format";
import { getHighlightLanguage, highlightBody } from "@/lib/highlight";
import { trackRequestViewed, trackRequestDetailTabChanged } from "@/lib/analytics";
import { jsonToTypeScript } from "@/lib/json-to-typescript";

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

export type Tab = "body" | "headers" | "query" | "raw";
export const TABS: Tab[] = ["body", "headers", "query", "raw"];

export function RequestDetail({ request, activeTab, onTabChange }: RequestDetailProps) {
  const [internalTab, setInternalTab] = useState<Tab>("body");
  const tab = activeTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;

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

  const curlCommand = generateCurlCommand(request);
  const fullTime = new Date(request.receivedAt).toLocaleString();
  const bodyFormat = detectFormat(request.contentType, request.body);
  const formattedBody = request.body ? formatBody(request.body, bodyFormat) : "(empty body)";
  const highlightedBody = highlightBody(formattedBody, bodyFormat);
  const highlightLanguage = getHighlightLanguage(bodyFormat);
  const isJsonBody = bodyFormat === "json" && !!request.body;
  const tsInterface = isJsonBody ? jsonToTypeScript(request.body!) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="border-b-2 border-foreground px-4 py-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="font-mono font-bold text-sm truncate">
              {request.method} {request.path}
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-0.5 flex items-center gap-3 flex-wrap">
              <span>{request.ip}</span>
              <span>{formatBytes(request.size)}</span>
              <span>{fullTime}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => handleCopy(curlCommand, "curl")}
              className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
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
            <ReplayDialog method={request.method} headers={request.headers} body={request.body} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b-2 border-foreground flex shrink-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => {
              if (tab === t) return;
              setTab(t);
              trackRequestDetailTabChanged(t);
            }}
            className={cn(
              "px-4 py-2 text-xs font-bold uppercase tracking-wide border-r-2 border-foreground last:border-r-0 cursor-pointer transition-colors",
              tab === t ? "bg-foreground text-background" : "bg-background hover:bg-muted"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        {tab === "body" && (
          <div className="relative">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border-2 border-foreground bg-muted">
                {getFormatLabel(bodyFormat)}
              </span>
            </div>
            <div className="absolute top-0 right-0 flex items-center gap-1">
              {tsInterface && (
                <button
                  onClick={() => handleCopy(tsInterface, "ts")}
                  className="neo-btn-outline py-1! px-2! text-xs flex items-center gap-1"
                  title="Copy as TypeScript interface"
                  aria-label={
                    copied === "ts"
                      ? "TypeScript copied to clipboard"
                      : "Copy as TypeScript interface"
                  }
                >
                  {copied === "ts" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Code className="h-3 w-3" />
                  )}
                  <span className="hidden sm:inline">{copied === "ts" ? "Copied!" : "TS"}</span>
                </button>
              )}
              {request.body && (
                <button
                  onClick={() => request.body && handleCopy(request.body, "body")}
                  className="neo-btn-outline py-1! px-2! text-xs flex items-center gap-1"
                  aria-label={
                    copied === "body" ? "Copied to clipboard" : "Copy body to clipboard"
                  }
                >
                  {copied === "body" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              )}
            </div>
            <pre className="neo-code syntax-highlight overflow-x-auto text-sm whitespace-pre-wrap break-words">
              {/* Safe: highlightBody escapes plain/form/text/binary output and Prism.highlight encodes token text for json/xml. */}
              <code
                className={`language-${highlightLanguage}`}
                dangerouslySetInnerHTML={{ __html: highlightedBody }}
              />
            </pre>
          </div>
        )}

        {tab === "headers" && (
          <div className="neo-code overflow-x-auto">
            <table className="text-sm font-mono w-full">
              <tbody>
                {Object.entries(request.headers).map(([key, value]) => (
                  <tr key={key} className="border-b border-foreground/20 last:border-0">
                    <td className="pr-4 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
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
          <div className="neo-code overflow-x-auto">
            {Object.keys(request.queryParams).length > 0 ? (
              <table className="text-sm font-mono w-full">
                <tbody>
                  {Object.entries(request.queryParams).map(([key, value]) => (
                    <tr key={key} className="border-b border-foreground/20 last:border-0">
                      <td className="pr-4 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                        {key}
                      </td>
                      <td className="py-1.5 break-all">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="text-muted-foreground">(no query params)</span>
            )}
          </div>
        )}

        {tab === "raw" && (
          <pre className="neo-code overflow-x-auto text-sm whitespace-pre-wrap break-all">
            {request.body || "(empty body)"}
          </pre>
        )}
      </div>
    </div>
  );
}

interface RequestDetailEmptyProps {
  slug?: string;
  endpointName?: string;
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
        <p className="font-bold uppercase tracking-wide text-sm">
          Select a request to view details
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="max-w-sm w-full space-y-5 text-center">
        <p className="font-bold uppercase tracking-wide text-sm text-muted-foreground">
          Select a request to view details
        </p>

        {/* Quick actions */}
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {onSendTest && (
            <button onClick={onSendTest} className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5">
              <Send className="h-3 w-3" />
              Send Test
            </button>
          )}
          {url && (
            <button onClick={handleCopy} className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5">
              {copied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
              {copied ? "Copied!" : "Copy URL"}
            </button>
          )}
          {onOpenSettings && (
            <button onClick={onOpenSettings} className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5">
              <Settings className="h-3 w-3" />
              Settings
            </button>
          )}
        </div>

        {/* Keyboard hint */}
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Press <kbd className="px-1 py-0.5 border border-foreground/30 bg-muted font-mono text-[10px]">?</kbd> for keyboard shortcuts
        </p>
      </div>
    </div>
  );
}
