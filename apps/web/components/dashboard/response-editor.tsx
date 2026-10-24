"use client";

import { useRef } from "react";
import { Plus, X } from "lucide-react";
import type { MockResponse } from "@webhooks-cc/sdk";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { parseStatusCode } from "@/lib/http";
import { StatusCodePicker } from "./status-code-picker";
import { PlaceholderMenu, REQUEST_PLACEHOLDERS, insertAtCursor } from "./placeholder-menu";

/**
 * One response: status, delay, body and headers. Every answer in the
 * Responses section (each rule's and the default) is edited with this, and
 * body and header values take `{{ ... }}` placeholders.
 */

export interface ResponseDraft {
  status: string;
  body: string;
  /** Milliseconds as typed; "" for none. */
  delay: string;
  headers: { key: string; name: string; value: string }[];
}

/** Headers the receiver never sends from a mock response. */
const BLOCKED_HEADERS = new Set([
  "set-cookie",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const MAX_RESPONSE_HEADERS = 20;

/** Suggested bodies by status code, offered when the body is empty or still a suggestion. */
export const SUGGESTED_BODIES: Record<string, string> = {
  "200": '{"status": "ok"}',
  "201": '{"id": "{{ uuid }}", "created": true}',
  "202": '{"accepted": true, "message": "Processing"}',
  "204": "",
  "301": "",
  "302": "",
  "304": "",
  "307": "",
  "308": "",
  "400": '{"error": "bad_request", "message": "Invalid input"}',
  "401": '{"error": "unauthorized"}',
  "403": '{"error": "forbidden"}',
  "404": '{"error": "not_found"}',
  "405": '{"error": "method_not_allowed"}',
  "409": '{"error": "conflict", "message": "Resource already exists"}',
  "422": '{"error": "unprocessable_entity", "message": "Validation failed"}',
  "429": '{"error": "too_many_requests", "retry_after": 60}',
  "500": '{"error": "internal_server_error"}',
  "502": '{"error": "bad_gateway"}',
  "503": '{"error": "service_unavailable"}',
  "504": '{"error": "gateway_timeout"}',
};
const SUGGESTED = new Set([
  ...Object.values(SUGGESTED_BODIES),
  // Earlier suggestions, so a body left as one still follows the status.
  '{"id": "abc-123", "created": true}',
]);

let nextKey = 1;
const newKey = () => `h${nextKey++}`;

export function toDraft(response: MockResponse | null | undefined): ResponseDraft {
  return {
    status: String(response?.status ?? 200),
    body: response?.body ?? "",
    delay: response?.delay ? String(response.delay) : "",
    headers: Object.entries(response?.headers ?? {}).map(([name, value]) => ({
      key: newKey(),
      name,
      value,
    })),
  };
}

export function fromDraft(draft: ResponseDraft): MockResponse {
  const delay = parseInt(draft.delay, 10);
  const headers: Record<string, string> = {};
  for (const row of draft.headers) {
    if (row.name.trim()) headers[row.name.trim()] = row.value;
  }
  return {
    status: parseStatusCode(draft.status, 200),
    body: draft.body,
    headers,
    ...(Number.isFinite(delay) && delay > 0 ? { delay: Math.min(delay, 30000) } : {}),
  };
}

/** Whether a draft is the plain `200 OK` the receiver sends without a mock response. */
export function isPlainOk(draft: ResponseDraft): boolean {
  const response = fromDraft(draft);
  return (
    response.status === 200 &&
    response.body === "" &&
    !response.delay &&
    Object.keys(response.headers).length === 0
  );
}

/** Problems that keep a draft from saving, in the order they show. */
export function draftIssues(draft: ResponseDraft): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const row of draft.headers) {
    const name = row.name.trim();
    if (!name) {
      if (row.value) issues.push("A header has a value but no name.");
      continue;
    }
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) issues.push(`${name} is not a valid header name.`);
    else if (BLOCKED_HEADERS.has(lower)) issues.push(`Mock responses cannot set ${name}.`);
    else if (seen.has(lower)) issues.push(`${name} is listed twice.`);
    seen.add(lower);
  }
  const delay = draft.delay.trim();
  if (delay && !/^\d+$/.test(delay)) issues.push("The delay is a whole number of milliseconds.");
  else if (delay && Number(delay) > 30000) issues.push("The delay is at most 30,000 ms.");
  return issues;
}

export function ResponseEditor({
  draft,
  onChange,
  idPrefix,
}: {
  draft: ResponseDraft;
  onChange: (next: ResponseDraft) => void;
  idPrefix: string;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const issues = draftIssues(draft);
  const set = (patch: Partial<ResponseDraft>) => onChange({ ...draft, ...patch });

  const insert = (text: string) => {
    const { value, cursor } = insertAtCursor(bodyRef.current, draft.body, text);
    set({ body: value });
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <StatusCodePicker
          id={`${idPrefix}-status`}
          label="Status"
          value={draft.status}
          onChange={(code) =>
            set({
              status: code,
              ...(!draft.body || SUGGESTED.has(draft.body)
                ? { body: SUGGESTED_BODIES[code] ?? draft.body }
                : {}),
            })
          }
        />
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-delay`} className="font-bold caps text-xs">
            Delay
          </Label>
          <div className="flex items-center gap-1.5">
            <input
              id={`${idPrefix}-delay`}
              inputMode="numeric"
              value={draft.delay}
              onChange={(e) => set({ delay: e.target.value.replace(/[^\d]/g, "").slice(0, 5) })}
              placeholder="0"
              aria-describedby={`${idPrefix}-delay-unit`}
              className="ui-input w-full text-sm font-mono py-2!"
            />
            <span id={`${idPrefix}-delay-unit`} className="text-xs text-muted-foreground">
              ms
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label htmlFor={`${idPrefix}-body`} className="block font-bold caps text-xs">
            Body
          </label>
          <PlaceholderMenu groups={REQUEST_PLACEHOLDERS} onInsert={insert} />
        </div>
        <Textarea
          id={`${idPrefix}-body`}
          ref={bodyRef}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
          placeholder='{"received": "{{ json.id }}"}'
          rows={4}
          spellCheck={false}
          className="border-strong border-line text-[13px] font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <span id={`${idPrefix}-headers-label`} className="block font-bold caps text-xs">
          Headers
        </span>
        {draft.headers.length > 0 && (
          <div role="group" aria-labelledby={`${idPrefix}-headers-label`} className="space-y-1.5">
            {draft.headers.map((row, index) => (
              <div
                key={row.key}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-1.5 items-center"
              >
                <input
                  aria-label={`Header ${index + 1} name`}
                  value={row.name}
                  onChange={(e) =>
                    set({
                      headers: draft.headers.map((h) =>
                        h.key === row.key ? { ...h, name: e.target.value } : h
                      ),
                    })
                  }
                  placeholder="Content-Type"
                  spellCheck={false}
                  className="ui-input text-[13px] font-mono py-1.5! px-2! min-w-0"
                />
                <input
                  aria-label={`Header ${index + 1} value`}
                  value={row.value}
                  onChange={(e) =>
                    set({
                      headers: draft.headers.map((h) =>
                        h.key === row.key ? { ...h, value: e.target.value } : h
                      ),
                    })
                  }
                  placeholder="application/json"
                  spellCheck={false}
                  className="ui-input text-[13px] font-mono py-1.5! px-2! min-w-0"
                />
                <button
                  type="button"
                  onClick={() => set({ headers: draft.headers.filter((h) => h.key !== row.key) })}
                  aria-label={`Remove header ${row.name.trim() || index + 1}`}
                  className="inline-flex items-center justify-center h-7 w-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={draft.headers.length >= MAX_RESPONSE_HEADERS}
          onClick={() =>
            set({ headers: [...draft.headers, { key: newKey(), name: "", value: "" }] })
          }
          className={cn(
            "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer",
            draft.headers.length >= MAX_RESPONSE_HEADERS && "opacity-50 cursor-not-allowed"
          )}
        >
          <Plus className="h-3 w-3" /> Add header
        </button>
      </div>

      {issues.length > 0 && (
        <ul className="text-xs text-destructive space-y-0.5">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
