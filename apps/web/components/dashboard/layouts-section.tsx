"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { layoutIssues } from "@webhooks-cc/sdk";
import {
  MAX_LAYOUTS,
  MAX_LINE_ITEM_COLUMNS,
  type Layout,
  type LineItemsSpec,
  type ParsedAttachment,
  type ParsedEmail,
} from "@webhooks-cc/sdk/email";
import { mergeEdits } from "@/lib/merge-edits";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { LAYOUT_TEMPLATES, layoutTemplate, type LayoutTemplate } from "@/lib/layout-templates";
import { groupedTemplates } from "@/lib/layout-template-groups";
import { useCopyWithFeedback } from "@/hooks/use-copy-with-feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { useSite } from "@/components/providers/site-provider";
import {
  fetchAiAssists,
  fetchDashboardRequests,
  previewLayouts,
  replayEndpoint,
  sendTestEmail,
  type DashboardEndpoint,
  type LayoutsPreview,
} from "@/lib/dashboard-api";
import { AiAssistPanel } from "./ai-assist-panel";
import { ConditionList } from "./condition-list";
import { EditPatternTrigger, EmailFieldsEditor } from "./email-fields-editor";
import { SaveFooter, Section, Segmented, SwitchRow, useSave } from "./settings-primitives";
import { stableStringify } from "@/lib/stable-json";
import { describeCondition, takesValue } from "@/lib/condition-labels";
import { Button } from "@/components/ui/button";
import { FieldControl } from "@/components/ui/field";

/**
 * Layouts: how this endpoint reads the emails of each sender or kind. The
 * first enabled layout whose conditions hold picks the email's fields, its
 * line items and whether its attachments are parsed. The preview runs the
 * draft on the newest email (or one picked from the list) on the server,
 * with RE2, without parsing attachments or using pages.
 */

type LineItemsMode = "none" | "text" | "html" | "attachment";

const inputClass = "text-[13px] font-mono [font-variant-ligatures:none] py-1.5! px-2! min-w-0";

/**
 * A blank layout. Given the domain of the newest email's sender, it applies
 * to that sender's emails and is named after it, which is what most first
 * layouts want; the condition is an ordinary one to change or remove.
 */
function newLayout(layouts: Layout[], senderDomain?: string | null): Layout {
  const taken = new Set(layouts.map((layout) => layout.id));
  let id = "";
  do {
    id = `layout-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  // Not "Layout 1": places that show the name already say it is a layout.
  const base = senderDomain ?? "New layout";
  const names = new Set(layouts.map((layout) => layout.name));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return {
    id,
    name,
    enabled: true,
    match: {
      logic: "and",
      conditions: senderDomain
        ? [{ field: "email", name: "from", op: "contains", value: senderDomain }]
        : [],
    },
    fields: [],
    lineItems: null,
    parseAttachments: false,
  };
}

/** The domain of an address ("orders@acme.example" gives "acme.example"), or null. */
function domainOf(address: string | null | undefined): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  const domain =
    at >= 0
      ? address!
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : "";
  return domain || null;
}

const TEMPLATE_GROUPS_SHOWN = groupedTemplates();
/** Past this many templates, the sender list gets a filter. */
const FILTER_FROM = 10;

/**
 * The template a layout came from: one added here this session, or one
 * added from a sender page, whose id is the template's ("shopify-orders",
 * "shopify-orders-2" for a second copy).
 */
function templateOf(layout: Layout, addedFrom: Record<string, string>): LayoutTemplate | null {
  return layoutTemplate(addedFrom[layout.id] ?? layout.id.replace(/-\d+$/, ""));
}

type SampleSend =
  | { kind: "saving" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string }
  | null;

type ReplayState =
  | { kind: "sending" }
  | { kind: "done"; requests: number; queued: number }
  | { kind: "error"; message: string }
  | null;

/** The Tried on picker's value for the newest email (a select item cannot be empty). */
const NEWEST_SAMPLE = "newest";

/** How far back "Read the last 7 days of email again" reaches. */
const REPLAY_DAYS = 7;
const REPLAY_LIMIT = 500;

function replayStatus(state: ReplayState): string | null {
  if (!state || state.kind === "sending") return state ? "Queueing..." : null;
  if (state.kind === "error") return state.message;
  if (state.requests === 0) return `No email from the last ${REPLAY_DAYS} days to read again.`;
  const queued = `${state.queued} email${state.queued === 1 ? "" : "s"} queued to be read again.`;
  // The route takes the oldest emails in the range first, up to its limit.
  return state.requests >= REPLAY_LIMIT
    ? `${queued} That is the oldest ${REPLAY_LIMIT}, the most one go takes.`
    : queued;
}

/** "Send the Shopify sample email": the template's sample, delivered to this endpoint. */
function SampleEmailButton({
  template,
  state,
  onSend,
  status = true,
  saveFirst = false,
}: {
  template: LayoutTemplate;
  state: SampleSend;
  onSend: (template: LayoutTemplate) => void;
  /** Show how the send went beside the button; off where another copy already says it. */
  status?: boolean;
  /**
   * The layouts have unsaved changes: the sample is read by the saved layouts
   * when it arrives, so the button saves them first.
   */
  saveFirst?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <Button
        variant="surface"
        className="py-1! px-2.5! text-xs"
        type="button"
        onClick={() => onSend(template)}
        disabled={state?.kind === "sending" || state?.kind === "saving"}
      >
        {saveFirst ? "Save, then send" : "Send"} the {template.sender} sample email
      </Button>
      {status && <SampleSendStatus state={state} />}
    </div>
  );
}

function SampleSendStatus({ state }: { state: SampleSend }) {
  const list = useSite().key === "mailhooks" ? "Inbox" : "Requests";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs",
        state?.kind === "error" ? "text-destructive-ink" : "text-muted-foreground"
      )}
    >
      {state?.kind === "saving"
        ? "Saving the layouts..."
        : state?.kind === "sending"
          ? "Sending..."
          : state?.kind === "sent"
            ? `Sent. It shows up in ${list} and here in a moment.`
            : state?.kind === "error"
              ? state.message
              : null}
    </span>
  );
}

/**
 * A layout in one line, for one just added from a template: "Shopify orders:
 * applies when email subject contains "placed by", reads 6 fields, and line items".
 */
function layoutSummary(layout: Layout): string {
  const conditions = layout.match?.conditions ?? [];
  const when =
    conditions.length === 0
      ? "every email"
      : conditions
          .map((condition) =>
            describeCondition(
              takesValue(condition.op) && condition.value
                ? { ...condition, value: `"${condition.value}"` }
                : condition
            )
          )
          .join(layout.match?.logic === "or" ? " or " : " and ");
  const count = layout.fields?.length ?? 0;
  const reads = `reads ${count} field${count === 1 ? "" : "s"}`;
  return `${layout.name}: applies when ${when}, ${reads}${layout.lineItems ? ", and line items" : ""}`;
}

function modeOf(layout: Layout): LineItemsMode {
  return layout.lineItems?.from ?? "none";
}

/** The problems that name a layout ("layout 2: ..."), by its place. */
function problemsByLayout(problems: string[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const problem of problems) {
    const match = /^layout (\d+): (.*)$/.exec(problem);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    out.set(index, [...(out.get(index) ?? []), match[2]]);
  }
  return out;
}

const ATTACHMENT_ERRORS: Record<string, string> = {
  limit: "not parsed: no pages left this month",
  not_kept: "not parsed: its contents were not kept",
  not_parsed: "parsed when an email arrives (the preview never parses)",
  too_large: "not parsed: larger than 32 MB",
  malformed: "could not be read",
  encrypted: "is encrypted",
  zip_bomb: "refused: it expands too far",
  empty: "is empty",
};

export function attachmentNote(attachment: ParsedAttachment): string {
  if (attachment.error) return ATTACHMENT_ERRORS[attachment.error] ?? attachment.error;
  // A stored parse read again (a replay or the preview) uses no pages.
  if (attachment.pages === 0) return "parsed before, no pages used";
  const pages = `${attachment.pages} page${attachment.pages === 1 ? "" : "s"}`;
  return attachment.truncated ? `${pages}, cut off at the limit` : pages;
}

/** The line items' columns in the layout's order (`jsonb` does not keep key order). */
function lineItemColumns(parsed: ParsedEmail): string[] {
  return parsed.lineItemColumns?.length > 0
    ? parsed.lineItemColumns
    : [...new Set(parsed.lineItems.flatMap((row) => Object.keys(row)))];
}

/** A column of numbers (quantities, prices): every value it has looks like one. */
function isNumericColumn(rows: Record<string, string | null>[], column: string): boolean {
  const values = rows.map((row) => row[column]?.trim() ?? "").filter((value) => value !== "");
  return values.length > 0 && values.every((value) => /^-?[\d.,]+$/.test(value));
}

function LineItemsTable({
  rows,
  columns,
  limit,
  more,
  label,
}: {
  rows: Record<string, string | null>[];
  columns: string[];
  limit: number;
  more: (count: number) => string;
  label?: string;
}) {
  const shown = rows.slice(0, limit);
  const numeric = new Set(columns.filter((column) => isNumericColumn(shown, column)));
  return (
    // As wide as its columns need (at least the width on a phone, 60% wider up),
    // so a few narrow columns do not spread across the panel.
    <div className="overflow-x-auto w-fit max-w-full min-w-full sm:min-w-[60%] border rounded-md">
      <table className="w-full text-xs" aria-label={label}>
        <thead>
          <tr className="bg-muted">
            {columns.map((column) => (
              <th
                key={column}
                className={cn(
                  "font-mono font-medium px-2.5 py-1.5",
                  numeric.has(column) ? "text-right tabular-nums" : "text-left"
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index} className="border-t border-border/20">
              {columns.map((column) => (
                <td
                  key={column}
                  className={cn(
                    "font-mono text-[13px] px-2.5 py-1.5 [font-variant-ligatures:none]",
                    numeric.has(column)
                      ? "text-right tabular-nums whitespace-nowrap"
                      : "break-words [overflow-wrap:anywhere]"
                  )}
                >
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <p className="text-xs text-muted-foreground px-2 py-1 border-t border-border/20">
          {more(rows.length - limit)}
        </p>
      )}
    </div>
  );
}

/**
 * The fields in the order the layout lists them (`jsonb` does not keep an
 * object's key order), then any the layout no longer names. The layout is
 * found among `layouts` by id, else by name.
 */
export function orderedFieldNames(parsed: ParsedEmail, layouts?: readonly unknown[]): string[] {
  const names = Object.keys(parsed.fields);
  const candidates = (layouts ?? []).filter(
    (layout): layout is Pick<Layout, "id" | "name" | "fields"> =>
      typeof layout === "object" && layout !== null && "id" in layout
  );
  const layout =
    candidates.find((entry) => entry.id === parsed.layout?.id) ??
    candidates.find((entry) => entry.name === parsed.layout?.name);
  if (!layout || !Array.isArray(layout.fields)) return names;
  const present = new Set(names);
  const ordered = layout.fields
    .map((field) => field?.name)
    .filter((name): name is string => typeof name === "string" && present.has(name));
  const placed = new Set(ordered);
  return [...new Set(ordered), ...names.filter((name) => !placed.has(name))];
}

/** Copies one parsed value; the icon turns to a check for a moment. */
function CopyValueButton({ name, value }: { name: string; value: string }) {
  const { copy, isCopied } = useCopyWithFeedback(1500);
  const copied = isCopied();
  return (
    <button
      type="button"
      aria-label={`Copy ${name}`}
      title="Copy"
      onClick={() => void copy(value)}
      className="shrink-0 -my-0.5 h-6 w-6 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

/** A parsed result: the layout, fields, line items and attachments. Shared with the email view. */
export function ParsedResult({
  parsed,
  layouts,
  onOpenLayouts,
}: {
  parsed: ParsedEmail;
  /** The endpoint's layouts (or the draft), so the fields show in their layout's order. */
  layouts?: readonly unknown[];
  /** Opens Settings at Layouts; given, the layout's name is a button that does it. */
  onOpenLayouts?: () => void;
}) {
  if (parsed.status !== "matched") {
    // Expected for mail no layout is written for yet: not an error.
    return <p className="text-sm text-muted-foreground">No layout applies to this email yet.</p>;
  }
  const fieldNames = orderedFieldNames(parsed, layouts);
  const columns = lineItemColumns(parsed);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Read by{" "}
        {onOpenLayouts ? (
          <button
            type="button"
            onClick={onOpenLayouts}
            title="Open in Settings, Layouts"
            className="font-semibold underline decoration-border/40 underline-offset-2 hover:decoration-current cursor-pointer"
          >
            {parsed.layout?.name}
          </button>
        ) : (
          <span className="font-semibold">{parsed.layout?.name}</span>
        )}
        {parsed.pages > 0 && (
          <span className="text-muted-foreground">
            {" "}
            ({parsed.pages} page{parsed.pages === 1 ? "" : "s"} parsed)
          </span>
        )}
      </p>
      {fieldNames.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-5 gap-y-1.5">
          {fieldNames.map((name) => {
            const value = parsed.fields[name];
            return (
              <div key={name} className="contents">
                <dt className="font-mono text-[13px] text-foreground/75 pt-px break-words [overflow-wrap:anywhere] [font-variant-ligatures:none]">
                  {name}
                </dt>
                <dd className="flex items-start gap-1.5 min-w-0">
                  {value != null ? (
                    <>
                      <span className="font-mono text-sm font-medium [overflow-wrap:anywhere] [font-variant-ligatures:none]">
                        {value}
                      </span>
                      <CopyValueButton name={name} value={value} />
                    </>
                  ) : (
                    <span className="text-[13px] text-destructive-ink">not found</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {parsed.lineItems.length > 0 && (
        <LineItemsTable
          rows={parsed.lineItems}
          columns={columns}
          limit={50}
          more={(count) => `${count} more line items in the JSON.`}
        />
      )}
      {parsed.attachments.length > 0 && (
        <ul className="text-xs space-y-0.5">
          {parsed.attachments.map((attachment) => (
            <li key={attachment.index}>
              <span className="font-mono">
                {attachment.filename ?? `attachment ${attachment.index + 1}`}
              </span>{" "}
              <span
                className={cn(
                  attachment.error && attachment.error !== "not_parsed"
                    ? "text-destructive-ink"
                    : "text-muted-foreground"
                )}
              >
                {attachment.format}, {attachmentNote(attachment)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What a layout's line-item pattern found in the email the preview read:
 * its rows, none, or nothing to show because the layout did not match it.
 */
type RowsFound =
  | { kind: "rows"; rows: Record<string, string | null>[]; columns: string[] }
  | { kind: "none" }
  | { kind: "unmatched" };

function LineItemsEditor({
  layout,
  index,
  found,
  where,
  onChange,
}: {
  layout: Layout;
  index: number;
  /** From the preview; null while there is none (no email, or a draft with problems). */
  found: RowsFound | null;
  /** The email the preview read, in words: "the newest email". */
  where: string;
  onChange: (spec: LineItemsSpec | null) => void;
}) {
  const mode = modeOf(layout);
  const spec = layout.lineItems ?? null;
  const n = index + 1;
  const columns = spec?.columns ?? [];
  // The pattern opened or closed by hand; otherwise open while there is
  // something to do with it (empty, or it finds nothing in the email), and
  // closed for one that finds rows or waits for its first email, such as a
  // ready-made layout's.
  const [patternOpen, setPatternOpen] = useState<boolean | null>(null);
  const open = patternOpen ?? (!spec?.pattern?.trim() || found?.kind === "none");
  const patternId = `layout-${layout.id}-line-pattern`;
  return (
    <div className="space-y-2">
      <Segmented<LineItemsMode>
        name={`Layout ${n}: line items`}
        value={mode}
        onChange={(next) =>
          onChange(
            next === "none"
              ? null
              : next === "attachment"
                ? { from: "attachment" }
                : { from: next, pattern: spec?.pattern ?? "" }
          )
        }
        options={[
          { value: "none", label: "None" },
          { value: "text", label: "From the text" },
          { value: "html", label: "From the HTML" },
          { value: "attachment", label: "From a spreadsheet" },
        ]}
      />
      {spec && spec.from !== "attachment" && (
        <Collapsible open={open} onOpenChange={setPatternOpen} className="space-y-1.5">
          {spec.pattern && found?.kind === "rows" && (
            <LineItemsTable
              rows={found.rows}
              columns={found.columns}
              limit={5}
              more={(count) => `${count} more rows in ${where}.`}
              label={`Layout ${n}: rows found`}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="flex-1 min-w-40 text-xs text-muted-foreground" aria-live="polite">
              {spec.pattern && found && found.kind !== "rows"
                ? found.kind === "none"
                  ? `No rows found in ${where}.`
                  : `This layout does not match ${where}, so there are no rows to show.`
                : null}
            </p>
            <EditPatternTrigger
              aria-label={`Layout ${n}: edit line item pattern`}
              className="ml-auto"
            />
          </div>
          {/* Typing keeps it open, even once the pattern finds rows. */}
          <CollapsiblePanel
            keepMounted
            className="space-y-1.5"
            onFocus={() => setPatternOpen(true)}
          >
            <label
              htmlFor={`${patternId}-input`}
              className="block text-xs font-medium text-muted-foreground"
            >
              Line item pattern (RE2)
            </label>
            <FieldControl
              id={`${patternId}-input`}
              aria-label={`Layout ${n}: line item pattern (RE2)`}
              value={spec.pattern ?? ""}
              onChange={(e) => onChange({ ...spec, pattern: e.target.value })}
              placeholder="(?P<sku>[A-Z]+-\d+)\s+x(?P<qty>\d+)"
              spellCheck={false}
              className={cn(inputClass, "w-full")}
            />
            <div className="flex flex-wrap gap-1.5">
              <label className="flex-1 min-w-48 space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  Start after (optional)
                </span>
                <FieldControl
                  value={spec.start ?? ""}
                  onChange={(e) => onChange({ ...spec, start: e.target.value || undefined })}
                  placeholder="e.g. Items ordered"
                  spellCheck={false}
                  className={cn(inputClass, "w-full")}
                />
              </label>
              <label className="flex-1 min-w-48 space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  Stop at (optional)
                </span>
                <FieldControl
                  value={spec.end ?? ""}
                  onChange={(e) => onChange({ ...spec, end: e.target.value || undefined })}
                  placeholder="e.g. Subtotal"
                  spellCheck={false}
                  className={cn(inputClass, "w-full")}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground max-w-[62ch]">
              An RE2 pattern found again and again; each match is a row, its named groups the
              columns.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      )}
      {spec?.from === "attachment" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <FieldControl
              aria-label={`Layout ${n}: attachment name`}
              value={spec.attachment ?? ""}
              onChange={(e) => onChange({ ...spec, attachment: e.target.value || undefined })}
              placeholder="File name, e.g. *.csv (the first spreadsheet when empty)"
              spellCheck={false}
              className={cn(inputClass, "flex-1 min-w-56")}
            />
            <FieldControl
              aria-label={`Layout ${n}: sheet`}
              value={spec.sheet ?? ""}
              onChange={(e) => onChange({ ...spec, sheet: e.target.value || undefined })}
              placeholder="Sheet (the first when empty)"
              spellCheck={false}
              className={cn(inputClass, "w-48")}
            />
          </div>
          {columns.map((column, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <FieldControl
                aria-label={`Layout ${n}: column ${i + 1} name`}
                value={column.name}
                onChange={(e) =>
                  onChange({
                    ...spec,
                    columns: columns.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)),
                  })
                }
                placeholder="sku"
                spellCheck={false}
                className={cn(inputClass, "w-36")}
              />
              <span className="text-xs text-muted-foreground">from column</span>
              <FieldControl
                aria-label={`Layout ${n}: column ${i + 1} source`}
                value={column.column}
                onChange={(e) =>
                  onChange({
                    ...spec,
                    columns: columns.map((c, j) =>
                      j === i ? { ...c, column: e.target.value } : c
                    ),
                  })
                }
                placeholder="Item code, or B"
                spellCheck={false}
                className={cn(inputClass, "flex-1")}
              />
              <button
                type="button"
                aria-label={`Layout ${n}: remove column ${i + 1}`}
                onClick={() => onChange({ ...spec, columns: columns.filter((_, j) => j !== i) })}
                className="p-1.5 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            variant="surface"
            className="py-1! px-2! text-xs inline-flex items-center gap-1"
            type="button"
            onClick={() => onChange({ ...spec, columns: [...columns, { name: "", column: "" }] })}
            disabled={columns.length >= MAX_LINE_ITEM_COLUMNS}
          >
            <Plus className="h-3 w-3" /> Column
          </Button>
          <p className="text-xs text-muted-foreground max-w-[62ch]">
            The first row is the header. Without columns, every column is kept under its header. The
            attachment is parsed, so it uses pages.
          </p>
        </div>
      )}
    </div>
  );
}

export function LayoutsSection({ endpoint }: { endpoint: DashboardEndpoint }) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const cap = endpoint.layoutsCap ?? 2;
  const initialKey = stableStringify(endpoint.layouts ?? []);
  const [layouts, setLayouts] = useState<Layout[]>(() => JSON.parse(initialKey) as Layout[]);
  const [open, setOpen] = useState<number | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [preview, setPreview] = useState<LayoutsPreview | null>(null);
  // Which email the preview reads: the newest (empty) or one of the recent ones.
  const [sampleId, setSampleId] = useState("");
  const [samples, setSamples] = useState<{ id: string; subject: string; from: string | null }[]>(
    []
  );
  const [samplesLoaded, setSamplesLoaded] = useState(false);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  // The template each layout added here came from, by layout id (this session only).
  const [addedFrom, setAddedFrom] = useState<Record<string, string>>({});
  const [sampleSend, setSampleSend] = useState<SampleSend>(null);
  // After a save: the endpoint's recent emails, read again with the saved layouts.
  const [replay, setReplay] = useState<ReplayState>(null);
  // Bumped when an email was sent from here, so the email list and the previews read again.
  const [reloadKey, setReloadKey] = useState(0);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (sentTimer.current && clearTimeout(sentTimer.current)), []);
  // The Add layout menu's sender filter.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuFilter, setMenuFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // AI setup: a layout drafted from emails, or a field found for an open layout.
  const [aiOffered, setAiOffered] = useState(false);
  const [assist, setAssist] = useState<
    // A field is found for one layout, by id: moving layouts must not move it.
    { kind: "layout" } | { kind: "field"; layoutId: string } | null
  >(null);
  // A layout just added, by id: its header is brought into view and its name focused
  // once it has rendered and the Add layout menu has closed.
  const revealId = useRef<string | null>(null);
  // Layouts added from a template here, shown as a summary until "Edit" opens
  // the editor: a ready-made layout rarely needs its patterns read first.
  const [summarized, setSummarized] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const id = revealId.current;
    if (!id || menuOpen) return;
    revealId.current = null;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`layout-${id}-header`)?.scrollIntoView({ block: "start" });
      (
        document.getElementById(`layout-${id}-name`) ?? document.getElementById(`layout-${id}-edit`)
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [layouts, open, menuOpen]);

  useEffect(() => {
    if (!accessToken) return;
    fetchAiAssists(accessToken, endpoint.slug)
      .then((info) => setAiOffered(info.offered))
      .catch(() => setAiOffered(false));
  }, [accessToken, endpoint.slug]);

  // The saved layouts changed (a save, another tab, an alert's AI repair):
  // layouts edited here keep their edits, the others take the saved copy.
  const baseKey = useRef(initialKey);
  useEffect(() => {
    const base = JSON.parse(baseKey.current) as Layout[];
    baseKey.current = initialKey;
    setLayouts((current) =>
      mergeEdits(base, current, JSON.parse(initialKey) as Layout[], (layout) => layout.id)
    );
  }, [initialKey]);

  const draftKey = stableStringify(layouts);
  // An assist is spent on a draft only while the plan would use another layout.
  const draftCap = Math.min(cap, MAX_LAYOUTS);
  const dirty = draftKey !== initialKey;
  const local = useMemo(() => layoutIssues(layouts), [layouts]);
  const allProblems = [...local, ...(preview?.problems ?? [])];
  const problems = problemsByLayout(allProblems);
  // Problems with the list as a whole (too many, too large together).
  const listProblems = allProblems.filter((problem) => !/^layout \d+: /.test(problem));

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchDashboardRequests(accessToken, endpoint.slug, 20, "email")
      .then((requests) => {
        if (cancelled) return;
        setSamples(
          requests.map((request) => ({
            id: request._id,
            subject: request.email?.subject || "(no subject)",
            from: request.email?.from?.[0]?.address ?? null,
          }))
        );
        setSamplesLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, endpoint.slug, reloadKey]);

  useEffect(() => {
    if (!accessToken || layouts.length === 0 || local.length > 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      previewLayouts(accessToken, endpoint.slug, layouts, sampleId || undefined)
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // draftKey stands for `layouts`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, endpoint.slug, draftKey, local.length, sampleId, reloadKey]);

  const update = (index: number, change: Partial<Layout>) =>
    setLayouts(layouts.map((layout, i) => (i === index ? { ...layout, ...change } : layout)));
  // Added layouts go at the end and open there.
  const addLayout = (layout: Layout) => {
    setLayouts([...layouts, layout]);
    setOpen(layouts.length);
    revealId.current = layout.id;
  };
  const addBlank = () => {
    addLayout(newLayout(layouts, domainOf(samples[0]?.from)));
    // The preview reads the newest email, the one the condition came from.
    setSampleId("");
  };
  const addTemplate = (template: LayoutTemplate) => {
    const { id } = newLayout(layouts);
    // Added closed, as a summary; Save in the footer keeps it as it is.
    setLayouts([...layouts, { ...structuredClone(template.layout), id }]);
    setOpen(null);
    revealId.current = id;
    setSummarized((current) => new Set(current).add(id));
    setAddedFrom((current) => ({ ...current, [id]: template.id }));
  };
  const openEditor = (index: number, id: string) => {
    setOpen(index);
    setSummarized((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const saveLayouts = () => {
    setTriedSave(true);
    setReplay(null);
    return save({ layouts }, () => {
      const [problem] = layoutIssues(layouts);
      if (problem) throw new Error(`Check the layouts: ${problem}.`);
    });
  };
  const sendSample = async (template: LayoutTemplate) => {
    if (!accessToken || sampleSend?.kind === "sending" || sampleSend?.kind === "saving") return;
    if (sentTimer.current) clearTimeout(sentTimer.current);
    // The saved layouts read the sample when it arrives: unsaved edits would
    // show as a match here and never be used on it.
    if (dirty) {
      setSampleSend({ kind: "saving" });
      if (!(await saveLayouts())) {
        setSampleSend({
          kind: "error",
          message: "The layouts were not saved, so the sample was not sent.",
        });
        return;
      }
    }
    setSampleSend({ kind: "sending" });
    try {
      const { requestId } = await sendTestEmail(accessToken, endpoint.slug, template.id);
      setSampleSend({ kind: "sent" });
      // The preview tries the sample, which is now captured (else the newest email, the sample too).
      setSampleId(requestId ?? "");
      setReloadKey((key) => key + 1);
      sentTimer.current = setTimeout(() => setSampleSend(null), 8000);
    } catch (sendError) {
      setSampleSend({
        kind: "error",
        message:
          sendError instanceof Error ? sendError.message : "The sample email could not be sent",
      });
    }
  };
  const templateFor = (layout: Layout) => templateOf(layout, addedFrom);
  // Offered in the open layout's notice when it came from a template, else in the preview's.
  const openTemplate = open !== null && layouts[open] ? templateFor(layouts[open]) : null;
  const firstTemplate =
    layouts.map(templateFor).find((template): template is LayoutTemplate => template !== null) ??
    null;
  const filter = menuFilter.trim().toLowerCase();
  const menuGroups = TEMPLATE_GROUPS_SHOWN.map((group) => ({
    ...group,
    templates: group.templates.filter(
      (template) =>
        !filter ||
        `${template.sender} ${template.kind} ${group.name}`.toLowerCase().includes(filter)
    ),
  })).filter((group) => group.templates.length > 0);
  const showFilter = LAYOUT_TEMPLATES.length > FILTER_FROM;
  const canDraft = aiOffered && layouts.length < draftCap && assist?.kind !== "layout";
  // Known once the preview or the email list has answered.
  const noEmail = preview ? !preview.request : samplesLoaded && samples.length === 0;
  const where = sampleId ? "the email tried" : "the newest email";
  const rowsFound = (layout: Layout): RowsFound | null => {
    if (!preview?.request || local.length > 0) return null;
    const parsed = preview.parsed;
    if (!parsed || parsed.status !== "matched" || parsed.layout?.id !== layout.id) {
      return { kind: "unmatched" };
    }
    return parsed.lineItems.length > 0
      ? { kind: "rows", rows: parsed.lineItems, columns: lineItemColumns(parsed) }
      : { kind: "none" };
  };
  // The open layout came from a sender's template, and the email tried is not that
  // sender's: its sample is the quickest proof the layout works.
  const openLayout = open !== null ? layouts[open] : undefined;
  const offerSample =
    openTemplate !== null &&
    openLayout !== undefined &&
    open !== null &&
    open < cap &&
    openLayout.enabled !== false &&
    rowsFound(openLayout)?.kind === "unmatched";

  // The Tried on row offers a sample only while no layout is open (an open
  // layout's notice offers its own): the first used layout from a sender's
  // template that does not read the email tried.
  // A summary offers its own sample, so the preview's offer and status wait.
  const summaryShown = layouts.some((layout, index) => open !== index && summarized.has(layout.id));
  const idleTemplate =
    open === null && !summaryShown
      ? (layouts
          .map((layout, index) => ({ layout, index }))
          .filter(
            ({ layout, index }) =>
              index < cap && layout.enabled !== false && rowsFound(layout)?.kind === "unmatched"
          )
          .map(({ layout }) => templateFor(layout))
          .find((template): template is LayoutTemplate => template !== null) ?? null)
      : null;

  const readRecentAgain = async () => {
    if (replay?.kind === "sending") return;
    if (!accessToken) {
      setReplay({ kind: "error", message: "Sign in again to read the emails again." });
      return;
    }
    setReplay({ kind: "sending" });
    try {
      const result = await replayEndpoint(accessToken, endpoint.slug, {
        since: Date.now() - REPLAY_DAYS * 24 * 60 * 60 * 1000,
        kind: "email",
      });
      setReplay({ kind: "done", requests: result.requests, queued: result.queued });
    } catch (replayError) {
      setReplay({
        kind: "error",
        message:
          replayError instanceof Error ? replayError.message : "The emails could not be queued.",
      });
    }
  };
  // Offered once saved layouts are in place, until the next edit.
  const offerReplay = saved && !dirty && layouts.length > 0;
  const replayNoteId = `layouts-replay-note-${endpoint.slug}`;

  const move = (index: number, by: -1 | 1) => {
    const next = [...layouts];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    setLayouts(next);
    setOpen(index + by);
  };

  return (
    <Section
      id="layouts"
      title="Layouts"
      description={`How this endpoint reads each sender's emails. The first layout whose conditions hold picks the fields, the line items and whether attachments are parsed. Your plan uses ${cap} layout${cap === 1 ? "" : "s"} per endpoint.`}
      footer={
        <>
          <SaveFooter
            dirty={dirty}
            saving={saving}
            error={error}
            saved={saved}
            hint="Layouts changed. Once saved, earlier emails can be read again with them."
            onReset={() => {
              setLayouts(JSON.parse(initialKey) as Layout[]);
              setTriedSave(false);
              setError(null);
              setSaved(false);
            }}
            onSave={() => void saveLayouts()}
          />
          {offerReplay && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 basis-full">
              {replay?.kind !== "done" && (
                <>
                  <Button
                    variant="surface"
                    className="py-1.5! px-3! text-xs inline-flex items-center gap-1.5"
                    type="button"
                    onClick={() => void readRecentAgain()}
                    disabled={replay?.kind === "sending"}
                    aria-describedby={replayNoteId}
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden />
                    Read the last {REPLAY_DAYS} days of email again
                  </Button>
                  <span id={replayNoteId} className="text-xs text-muted-foreground">
                    {(endpoint.destinationCount ?? 0) > 0
                      ? "They are parsed with the saved layouts and sent to your destinations again."
                      : "They are parsed with the saved layouts."}
                  </span>
                </>
              )}
              <span
                role="status"
                aria-live="polite"
                className={cn(
                  "text-xs empty:hidden",
                  replay?.kind === "error" ? "text-destructive-ink" : "text-muted-foreground"
                )}
              >
                {replayStatus(replay)}
              </span>
            </div>
          )}
        </>
      }
    >
      {layouts.length > 0 && (
        <ol className="space-y-2.5" aria-label="Layouts">
          {layouts.map((layout, index) => {
            const n = index + 1;
            const unused = index >= cap;
            const expanded = open === index;
            const layoutProblems = problems.get(index) ?? [];
            const matched = preview?.parsed?.layout?.id === layout.id;
            const summaryTemplate =
              !expanded && summarized.has(layout.id) ? templateFor(layout) : null;
            return (
              <Collapsible
                key={layout.id}
                open={expanded}
                onOpenChange={(next) => (next ? openEditor(index, layout.id) : setOpen(null))}
                render={<li className="border rounded-md bg-card" />}
              >
                <div
                  id={`layout-${layout.id}-header`}
                  className="flex flex-wrap items-center gap-2 p-2.5 scroll-mt-4"
                >
                  <span className="text-xs text-muted-foreground w-5">{n}.</span>
                  <CollapsibleTrigger className="text-sm font-semibold text-left cursor-pointer hover:underline">
                    {layout.name || `Layout ${n}`}
                  </CollapsibleTrigger>
                  {layout.enabled === false && (
                    <span className="text-xs text-muted-foreground">off</span>
                  )}
                  {unused && (
                    <span className="text-xs text-destructive-ink">
                      past your plan&apos;s {cap}: not used
                    </span>
                  )}
                  {matched && (
                    <span className="text-xs text-primary font-medium">
                      matches the email below
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={`Move layout ${n} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="p-1.5 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move layout ${n} down`}
                      disabled={index === layouts.length - 1}
                      onClick={() => move(index, 1)}
                      className="p-1.5 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove layout ${n}`}
                      onClick={() => {
                        setLayouts(layouts.filter((_, i) => i !== index));
                        setOpen(null);
                      }}
                      className="p-1.5 text-muted-foreground hover:text-destructive-ink cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {layoutProblems.length > 0 && (triedSave || expanded) && (
                  <p className="text-xs text-destructive-ink px-2.5 pb-2" aria-live="polite">
                    {layoutProblems[0]}
                  </p>
                )}
                {!expanded && summarized.has(layout.id) && (
                  <div className="border-t border-border/20 p-3 space-y-2.5">
                    <p className="text-sm">{layoutSummary(layout)}.</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <SwitchRow
                        id={`layout-${layout.id}-enabled`}
                        label="On"
                        checked={layout.enabled !== false}
                        onChange={(next) => update(index, { enabled: next })}
                      />
                      {summaryTemplate && (
                        <SampleEmailButton
                          template={summaryTemplate}
                          state={sampleSend}
                          onSend={sendSample}
                          saveFirst={dirty}
                        />
                      )}
                      <CollapsibleTrigger
                        id={`layout-${layout.id}-edit`}
                        aria-label={`Edit layout ${n}`}
                        className="ml-auto py-1! px-2.5! text-xs inline-flex items-center gap-1"
                        render={<Button variant="surface" />}
                      >
                        Edit layout
                        <ChevronDown className="h-3 w-3" aria-hidden />
                      </CollapsibleTrigger>
                    </div>
                  </div>
                )}
                <CollapsiblePanel className="border-t border-border/20 p-3 space-y-4">
                  {noEmail && (
                    <div className="space-y-1.5">
                      <p className="text-sm text-muted-foreground">
                        No emails yet. Add the fields now; the preview runs on your first email.
                      </p>
                      {openTemplate && (
                        <SampleEmailButton
                          template={openTemplate}
                          state={sampleSend}
                          onSend={sendSample}
                          saveFirst={dirty}
                        />
                      )}
                    </div>
                  )}
                  {offerSample && openTemplate && (
                    <div className="space-y-1.5">
                      <p className="text-sm text-muted-foreground">
                        The email tried is not from {openTemplate.sender}. Send the{" "}
                        {openTemplate.sender} sample email, or pick another email under Tried on.
                      </p>
                      <SampleEmailButton
                        template={openTemplate}
                        state={sampleSend}
                        onSend={sendSample}
                        saveFirst={dirty}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <FieldControl
                      className="text-sm py-1.5! px-2! w-64"
                      id={`layout-${layout.id}-name`}
                      aria-label={`Layout ${n}: name`}
                      value={layout.name}
                      onChange={(e) => update(index, { name: e.target.value })}
                      maxLength={100}
                    />
                    <SwitchRow
                      id={`layout-${layout.id}-enabled`}
                      label="On"
                      checked={layout.enabled !== false}
                      onChange={(next) => update(index, { enabled: next })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <h4 className="text-sm font-semibold">When it applies</h4>
                    <ConditionList
                      conditions={layout.match?.conditions ?? []}
                      logic={layout.match?.logic ?? "and"}
                      use="filter"
                      idPrefix={`layout-${layout.id}`}
                      showRequired={triedSave}
                      emailFieldNames={(endpoint.emailFields ?? []).map((field) => field.name)}
                      emptyLabel="Every email (add a condition, such as the sender, to tell layouts apart)."
                      lead={false}
                      onChange={(next) => update(index, { match: next })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <h4 className="text-sm font-semibold">Fields for this layout</h4>
                    <EmailFieldsEditor
                      slug={endpoint.slug}
                      fields={layout.fields ?? []}
                      onChange={(fields) => update(index, { fields })}
                      showRequired={triedSave}
                      emailAddress={endpoint.emailAddress ?? ""}
                      requestId={sampleId || undefined}
                      refreshKey={reloadKey}
                      layoutUnmatched={rowsFound(layout)?.kind === "unmatched"}
                    />
                    {aiOffered &&
                      (assist?.kind === "field" && assist.layoutId === layout.id ? (
                        <AiAssistPanel
                          slug={endpoint.slug}
                          samples={samples}
                          mode={{ kind: "field" }}
                          onAddField={(field) =>
                            update(index, {
                              fields: [
                                ...(layout.fields ?? []).filter((f) => f.name !== field.name),
                                field,
                              ],
                            })
                          }
                          onClose={() => setAssist(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAssist({ kind: "field", layoutId: layout.id })}
                          className="text-xs text-muted-foreground underline inline-flex items-center gap-1"
                        >
                          <Sparkles className="h-3 w-3" /> Find a field with AI
                        </button>
                      ))}
                  </div>
                  <div className="space-y-1.5">
                    <h4 className="text-sm font-semibold">Line items</h4>
                    <LineItemsEditor
                      layout={layout}
                      index={index}
                      found={rowsFound(layout)}
                      where={where}
                      onChange={(lineItems) => update(index, { lineItems })}
                    />
                  </div>
                  <SwitchRow
                    id={`layout-${layout.id}-attachments`}
                    label="Parse attachments"
                    help="CSV, TSV, XLSX, XLS, ODS, PDF text and plain text files become rows and text in the JSON. Each started 1,000 rows of a sheet, PDF page or text file is a parsed page."
                    checked={layout.parseAttachments === true}
                    onChange={(next) => update(index, { parseAttachments: next })}
                  />
                </CollapsiblePanel>
              </Collapsible>
            );
          })}
        </ol>
      )}
      {listProblems.length > 0 && (
        <p className="text-xs text-destructive-ink" aria-live="polite">
          {listProblems[0]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(next) => {
            setMenuOpen(next);
            if (!next) setMenuFilter("");
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant={layouts.length === 0 ? "primary" : "surface"}
                type="button"
                disabled={layouts.length >= MAX_LAYOUTS}
                className="py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
              />
            }
          >
            <Plus className="h-3 w-3" />
            Add layout
            <ChevronDown className="h-3 w-3" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={menuRef}
            align="start"
            // Always below the button: flipped up, it would cover the endpoint bar.
            side="bottom"
            collisionAvoidance={{ side: "none", align: "none", fallbackAxisSide: "none" }}
            // Focus goes to the added layout's name, not back to the trigger below it.
            finalFocus={false}
            className="w-72 max-h-[min(24rem,var(--available-height))] overflow-y-auto! border shadow-float"
            onKeyDown={(e) => {
              // Typing anywhere in the menu filters the senders (instead of
              // the menu's own jump to the item starting with that letter).
              const input = filterRef.current;
              if (
                !input ||
                e.target === input ||
                e.key.length !== 1 ||
                e.key === " " ||
                e.ctrlKey ||
                e.metaKey ||
                e.altKey
              ) {
                return;
              }
              e.preventDefault();
              // Or the menu's typeahead also takes the letter and moves focus.
              e.preventBaseUIHandler();
              setMenuFilter((current) => current + e.key);
              input.focus();
            }}
          >
            <DropdownMenuItem onClick={addBlank}>
              <Plus className="h-3.5 w-3.5" />
              Blank layout
            </DropdownMenuItem>
            {canDraft && (
              <DropdownMenuItem onClick={() => setAssist({ kind: "layout" })}>
                <Sparkles className="h-3.5 w-3.5" />
                Draft with AI
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-semibold">
              Start from a sender
            </DropdownMenuLabel>
            {showFilter && (
              <div className="px-2 pb-1.5">
                <FieldControl
                  className="text-xs py-1! px-2! w-full"
                  ref={filterRef}
                  type="search"
                  aria-label="Filter senders"
                  placeholder="Filter, e.g. Shopify or bookings"
                  value={menuFilter}
                  onChange={(e) => setMenuFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      menuRef.current?.querySelector<HTMLElement>("[data-template-item]")?.focus();
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const first = menuGroups[0]?.templates[0];
                      if (first) {
                        addTemplate(first);
                        setMenuOpen(false);
                        setMenuFilter("");
                      }
                      return;
                    }
                    // Keep the menu's own keys (letters jump to items, Tab is held) out of the input.
                    e.stopPropagation();
                  }}
                  spellCheck={false}
                />
              </div>
            )}
            {menuGroups.map((group) => (
              <DropdownMenuGroup key={group.name}>
                <DropdownMenuLabel className="text-[11px] text-muted-foreground font-medium pt-2 pb-1">
                  {group.name}
                </DropdownMenuLabel>
                {group.templates.map((template) => (
                  <DropdownMenuItem
                    key={template.id}
                    data-template-item=""
                    onClick={() => addTemplate(template)}
                    className="flex-wrap gap-x-1.5 gap-y-0"
                  >
                    <span className="font-semibold">{template.sender}</span>
                    <span className="text-muted-foreground">{template.kind}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
            {menuGroups.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
                No sender matches &ldquo;{menuFilter.trim()}&rdquo;. Try a blank layout.
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {layouts.length === 0 && (
          <span className="text-sm text-muted-foreground basis-full">
            Start from a sender you already get mail from, or add a blank layout. Without layouts,
            emails are delivered as they arrive, with your fields.
          </span>
        )}
      </div>
      {assist?.kind === "layout" && layouts.length < draftCap && (
        <AiAssistPanel
          slug={endpoint.slug}
          samples={samples}
          mode={{ kind: "layout" }}
          onUseLayout={(drafted) => {
            // Without a condition it would read every email (the panel offers none such).
            if (!drafted.match) return;
            const base = newLayout(layouts);
            addLayout({
              ...base,
              name: drafted.name ?? base.name,
              match: { logic: "and", conditions: [drafted.match] },
              fields: drafted.fields,
            });
          }}
          onClose={() => setAssist(null)}
        />
      )}
      {layouts.length > 0 && preview && (
        <div className="pt-4 border-t border-border/20 space-y-2" aria-live="polite">
          {preview.request ? (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Tried on</h3>
              <Select
                value={sampleId || NEWEST_SAMPLE}
                onValueChange={(value) => setSampleId(value === NEWEST_SAMPLE ? "" : value)}
              >
                <SelectTrigger
                  aria-label="Email to try the layouts on"
                  className="h-auto w-auto min-w-0 max-w-full gap-1.5 text-[13px] rounded-md border border-border bg-background px-2 py-1 max-md:py-1.5 text-left cursor-pointer focus:ring-offset-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))] border shadow-float">
                  <SelectItem value={NEWEST_SAMPLE} className="text-[13px]">
                    The newest email
                    {sampleId ? "" : `, "${preview.request.subject || "(no subject)"}"`}
                  </SelectItem>
                  {/* An email sent from here is tried before the list has read it again. */}
                  {sampleId && !samples.some((sample) => sample.id === sampleId) && (
                    <SelectItem value={sampleId} className="text-[13px]">
                      The email just sent
                    </SelectItem>
                  )}
                  {samples.map((sample) => (
                    <SelectItem key={sample.id} value={sample.id} className="text-[13px]">
                      {sample.subject}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* An open layout's notice offers its own, so the button shows once. */}
              {idleTemplate && (
                <SampleEmailButton
                  template={idleTemplate}
                  state={sampleSend}
                  onSend={sendSample}
                  saveFirst={dirty}
                  status={false}
                />
              )}
            </div>
          ) : (
            <h3 className="text-sm font-semibold">No email yet</h3>
          )}
          {preview.request ? (
            <>
              {/* The status of a send from the Tried on row; an open layout's notice has its own. */}
              {!summaryShown && (sampleSend?.kind === "sent" || (open === null && sampleSend)) && (
                <SampleSendStatus state={sampleSend} />
              )}
              {preview.parsed ? <ParsedResult parsed={preview.parsed} layouts={layouts} /> : null}
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Send an email to <span className="font-mono">{endpoint.emailAddress}</span> to try
                the layouts.
              </p>
              {/* Once: the open layout's notice offers it when that layout has a sample. */}
              {firstTemplate && !openTemplate && !summaryShown && (
                <SampleEmailButton
                  template={firstTemplate}
                  state={sampleSend}
                  onSend={sendSample}
                  saveFirst={dirty}
                />
              )}
            </>
          )}
        </div>
      )}
    </Section>
  );
}
