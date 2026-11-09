"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Sparkles, Trash2, X } from "lucide-react";
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
import { LAYOUT_TEMPLATES, layoutTemplate, type LayoutTemplate } from "@/lib/layout-templates";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  fetchAiAssists,
  fetchDashboardRequests,
  previewLayouts,
  sendTestEmail,
  type DashboardEndpoint,
  type LayoutsPreview,
} from "@/lib/dashboard-api";
import { AiAssistPanel } from "./ai-assist-panel";
import { ConditionList } from "./condition-list";
import { EmailFieldsEditor } from "./email-fields-editor";
import { SaveFooter, Section, Segmented, SwitchRow, useSave } from "./settings-primitives";

/**
 * Layouts: how this endpoint reads the emails of each sender or kind. The
 * first enabled layout whose conditions hold picks the email's fields, its
 * line items and whether its attachments are parsed. The preview runs the
 * draft on the newest email (or one picked from the list) on the server,
 * with RE2, without parsing attachments or using pages.
 */

type LineItemsMode = "none" | "text" | "html" | "attachment";

const inputClass =
  "ui-input text-[13px] font-mono [font-variant-ligatures:none] py-1.5! px-2! min-w-0";

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

/**
 * The Add layout menu's sender groups, by template id. A template not listed
 * here still shows, under "Other senders".
 */
const TEMPLATE_GROUPS: { name: string; ids: string[] }[] = [
  {
    name: "Commerce",
    ids: [
      "shopify-orders",
      "woocommerce-orders",
      "etsy-sales",
      "amazon-seller-orders",
      "ebay-sales",
    ],
  },
  { name: "Payments", ids: ["stripe-receipts", "paypal-payments"] },
  {
    name: "Bookings and travel",
    ids: ["booking-com-reservations", "airbnb-reservations", "calendly-bookings"],
  },
  { name: "Forms, reports and files", ids: ["form-responses", "csv-reports", "pdf-invoices"] },
];

function groupedTemplates(): { name: string; templates: LayoutTemplate[] }[] {
  const listed = new Set(TEMPLATE_GROUPS.flatMap((group) => group.ids));
  const groups = TEMPLATE_GROUPS.map((group) => ({
    name: group.name,
    templates: group.ids
      .map((id) => layoutTemplate(id))
      .filter((template): template is LayoutTemplate => template !== null),
  }));
  const other = LAYOUT_TEMPLATES.filter((template) => !listed.has(template.id));
  if (other.length > 0) groups.push({ name: "Other senders", templates: other });
  return groups.filter((group) => group.templates.length > 0);
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
  { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string } | null;

/** "Send the Shopify sample email": the template's sample, delivered to this endpoint. */
function SampleEmailButton({
  template,
  state,
  onSend,
  status = true,
}: {
  template: LayoutTemplate;
  state: SampleSend;
  onSend: (template: LayoutTemplate) => void;
  /** Show how the send went beside the button; off where another copy already says it. */
  status?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <button
        type="button"
        onClick={() => onSend(template)}
        disabled={state?.kind === "sending"}
        className="ui-btn-outline py-1! px-2.5! text-xs"
      >
        Send the {template.sender} sample email
      </button>
      {status && <SampleSendStatus state={state} />}
    </div>
  );
}

function SampleSendStatus({ state }: { state: SampleSend }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs",
        state?.kind === "error" ? "text-destructive-ink" : "text-muted-foreground"
      )}
    >
      {state?.kind === "sending"
        ? "Sending..."
        : state?.kind === "sent"
          ? "Sent. It shows up in Requests and here in a moment."
          : state?.kind === "error"
            ? state.message
            : null}
    </span>
  );
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
  return (
    <div className="overflow-x-auto border-strong border-line rounded-md">
      <table className="w-full text-xs" aria-label={label}>
        <thead>
          <tr className="bg-muted">
            {columns.map((column) => (
              <th key={column} className="text-left font-mono font-medium px-2 py-1">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row, index) => (
            <tr key={index} className="border-t border-line/20">
              {columns.map((column) => (
                <td key={column} className="font-mono px-2 py-1 break-all">
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <p className="text-xs text-muted-foreground px-2 py-1 border-t border-line/20">
          {more(rows.length - limit)}
        </p>
      )}
    </div>
  );
}

/** A parsed result: the layout, fields, line items and attachments. Shared with the email view. */
export function ParsedResult({ parsed }: { parsed: ParsedEmail }) {
  if (parsed.status !== "matched") {
    // Expected for mail no layout is written for yet: not an error.
    return <p className="text-sm text-muted-foreground">No layout applies to this email yet.</p>;
  }
  const fieldNames = Object.keys(parsed.fields);
  const columns = lineItemColumns(parsed);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Read by <span className="font-semibold">{parsed.layout?.name}</span>
        {parsed.pages > 0 && (
          <span className="text-muted-foreground">
            {" "}
            ({parsed.pages} page{parsed.pages === 1 ? "" : "s"} parsed)
          </span>
        )}
      </p>
      {fieldNames.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {fieldNames.map((name) => (
            <div key={name} className="contents">
              <dt className="font-mono text-xs text-muted-foreground pt-0.5">{name}</dt>
              <dd className="font-mono text-xs break-all">
                {parsed.fields[name] ?? <span className="text-destructive-ink">not found</span>}
              </dd>
            </div>
          ))}
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
        <div className="space-y-1.5">
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
            <button
              type="button"
              onClick={() => setPatternOpen(!open)}
              aria-expanded={open}
              aria-controls={patternId}
              aria-label={`Layout ${n}: edit line item pattern`}
              className="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Edit pattern
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </button>
          </div>
          {/* Typing keeps it open, even once the pattern finds rows. */}
          <div
            id={patternId}
            hidden={!open}
            className="space-y-1.5"
            onFocus={() => setPatternOpen(true)}
          >
            <label
              htmlFor={`${patternId}-input`}
              className="block text-xs font-medium text-muted-foreground"
            >
              Line item pattern (RE2)
            </label>
            <input
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
                <input
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
                <input
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
          </div>
        </div>
      )}
      {spec?.from === "attachment" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <input
              aria-label={`Layout ${n}: attachment name`}
              value={spec.attachment ?? ""}
              onChange={(e) => onChange({ ...spec, attachment: e.target.value || undefined })}
              placeholder="File name, e.g. *.csv (the first spreadsheet when empty)"
              spellCheck={false}
              className={cn(inputClass, "flex-1 min-w-56")}
            />
            <input
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
              <input
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
              <input
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
          <button
            type="button"
            onClick={() => onChange({ ...spec, columns: [...columns, { name: "", column: "" }] })}
            disabled={columns.length >= MAX_LINE_ITEM_COLUMNS}
            className="ui-btn-outline py-1! px-2! text-xs inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Column
          </button>
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
  const initialKey = JSON.stringify(endpoint.layouts ?? []);
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
  useEffect(() => {
    const id = revealId.current;
    if (!id || menuOpen) return;
    revealId.current = null;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`layout-${id}-header`)?.scrollIntoView({ block: "start" });
      document.getElementById(`layout-${id}-name`)?.focus({ preventScroll: true });
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

  const draftKey = JSON.stringify(layouts);
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
    addLayout({ ...structuredClone(template.layout), id });
    setAddedFrom((current) => ({ ...current, [id]: template.id }));
  };
  const sendSample = async (template: LayoutTemplate) => {
    if (!accessToken || sampleSend?.kind === "sending") return;
    if (sentTimer.current) clearTimeout(sentTimer.current);
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
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Layouts changed. Replay earlier emails to read them again."
          onReset={() => {
            setLayouts(JSON.parse(initialKey) as Layout[]);
            setTriedSave(false);
            setError(null);
            setSaved(false);
          }}
          onSave={() => {
            setTriedSave(true);
            void save({ layouts }, () => {
              const [problem] = layoutIssues(layouts);
              if (problem) throw new Error(`Check the layouts: ${problem}.`);
            });
          }}
        />
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
            return (
              <li key={layout.id} className="border-strong border-line rounded-md bg-card">
                <div
                  id={`layout-${layout.id}-header`}
                  className="flex flex-wrap items-center gap-2 p-2.5 scroll-mt-4"
                >
                  <span className="text-xs text-muted-foreground w-5">{n}.</span>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : index)}
                    aria-expanded={expanded}
                    className="text-sm font-semibold text-left cursor-pointer hover:underline"
                  >
                    {layout.name || `Layout ${n}`}
                  </button>
                  {layout.enabled === false && (
                    <span className="text-xs text-muted-foreground">off</span>
                  )}
                  {unused && (
                    <span className="text-xs text-destructive-ink">
                      past your plan&apos;s {cap}: not used
                    </span>
                  )}
                  {matched && (
                    <span className="text-xs text-primary-ink font-medium">
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
                {expanded && (
                  <div className="border-t border-line/20 p-3 space-y-4">
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
                        />
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        id={`layout-${layout.id}-name`}
                        aria-label={`Layout ${n}: name`}
                        value={layout.name}
                        onChange={(e) => update(index, { name: e.target.value })}
                        maxLength={100}
                        className="ui-input text-sm py-1.5! px-2! w-64"
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
                  </div>
                )}
              </li>
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
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={layouts.length >= MAX_LAYOUTS}
              className={cn(
                layouts.length === 0 ? "ui-btn-primary" : "ui-btn-outline",
                "py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
              )}
            >
              <Plus className="h-3 w-3" />
              Add layout
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={menuRef}
            align="start"
            // Focus goes to the added layout's name, not back to the trigger below it.
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="w-72 max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto! border-strong border-line shadow-raised"
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
              setMenuFilter((current) => current + e.key);
              input.focus();
            }}
          >
            <DropdownMenuItem onSelect={addBlank}>
              <Plus className="h-3.5 w-3.5" />
              Blank layout
            </DropdownMenuItem>
            {canDraft && (
              <DropdownMenuItem onSelect={() => setAssist({ kind: "layout" })}>
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
                <input
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
                  className="ui-input text-xs py-1! px-2! w-full"
                />
              </div>
            )}
            {menuGroups.map((group) => (
              <DropdownMenuGroup key={group.name}>
                <DropdownMenuLabel className="caps text-[11px] text-muted-foreground font-medium pt-2 pb-1">
                  {group.name}
                </DropdownMenuLabel>
                {group.templates.map((template) => (
                  <DropdownMenuItem
                    key={template.id}
                    data-template-item=""
                    onSelect={() => addTemplate(template)}
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
        <div className="pt-4 border-t border-line/20 space-y-2" aria-live="polite">
          {preview.request ? (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Tried on</h3>
              <select
                aria-label="Email to try the layouts on"
                value={sampleId}
                onChange={(e) => setSampleId(e.target.value)}
                className="ui-input text-[13px] py-1! px-2! max-w-full"
              >
                <option value="">
                  The newest email
                  {sampleId ? "" : `, "${preview.request.subject || "(no subject)"}"`}
                </option>
                {samples.map((sample) => (
                  <option key={sample.id} value={sample.id}>
                    {sample.subject}
                  </option>
                ))}
              </select>
              {/* The layout notice above says the same with the send status. */}
              {offerSample && openTemplate && (
                <SampleEmailButton
                  template={openTemplate}
                  state={sampleSend}
                  onSend={sendSample}
                  status={false}
                />
              )}
            </div>
          ) : (
            <h3 className="text-sm font-semibold">No email yet</h3>
          )}
          {preview.request ? (
            <>
              {sampleSend?.kind === "sent" && <SampleSendStatus state={sampleSend} />}
              {preview.parsed ? <ParsedResult parsed={preview.parsed} /> : null}
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Send an email to <span className="font-mono">{endpoint.emailAddress}</span> to try
                the layouts.
              </p>
              {/* Once: the open layout's notice offers it when that layout has a sample. */}
              {firstTemplate && !openTemplate && (
                <SampleEmailButton
                  template={firstTemplate}
                  state={sampleSend}
                  onSend={sendSample}
                />
              )}
            </>
          )}
        </div>
      )}
    </Section>
  );
}
