"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2, X } from "lucide-react";
import { layoutIssues } from "@webhooks-cc/sdk";
import {
  MAX_LAYOUTS,
  MAX_LINE_ITEM_COLUMNS,
  type Layout,
  type LineItemsSpec,
  type ParsedAttachment,
  type ParsedEmail,
} from "@webhooks-cc/sdk/email";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  fetchAiAssists,
  fetchDashboardRequests,
  previewLayouts,
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

function newLayout(layouts: Layout[]): Layout {
  const taken = new Set(layouts.map((layout) => layout.id));
  let id = "";
  do {
    id = `layout-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return {
    id,
    name: `Layout ${layouts.length + 1}`,
    enabled: true,
    match: { logic: "and", conditions: [] },
    fields: [],
    lineItems: null,
    parseAttachments: false,
  };
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

/** A parsed result: the layout, fields, line items and attachments. Shared with the email view. */
export function ParsedResult({ parsed }: { parsed: ParsedEmail }) {
  if (parsed.status !== "matched") {
    return <p className="text-sm text-destructive">No layout matched this email.</p>;
  }
  const fieldNames = Object.keys(parsed.fields);
  const columns =
    parsed.lineItemColumns?.length > 0
      ? parsed.lineItemColumns
      : [...new Set(parsed.lineItems.flatMap((row) => Object.keys(row)))];
  return (
    <div className="space-y-3 text-sm">
      <p>
        Layout <span className="font-semibold">{parsed.layout?.name}</span>
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
                {parsed.fields[name] ?? <span className="text-destructive">not found</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {parsed.lineItems.length > 0 && (
        <div className="overflow-x-auto border-strong border-line rounded-md">
          <table className="w-full text-xs">
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
              {parsed.lineItems.slice(0, 50).map((row, index) => (
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
          {parsed.lineItems.length > 50 && (
            <p className="text-xs text-muted-foreground px-2 py-1 border-t border-line/20">
              {parsed.lineItems.length - 50} more line items in the JSON.
            </p>
          )}
        </div>
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
                    ? "text-destructive"
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

function LineItemsEditor({
  layout,
  index,
  onChange,
}: {
  layout: Layout;
  index: number;
  onChange: (spec: LineItemsSpec | null) => void;
}) {
  const mode = modeOf(layout);
  const spec = layout.lineItems ?? null;
  const n = index + 1;
  const columns = spec?.columns ?? [];
  return (
    <div className="space-y-2">
      <Segmented<LineItemsMode>
        name={`Layout ${n}: line items`}
        value={mode}
        size="xs"
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
          <input
            aria-label={`Layout ${n}: line item pattern`}
            value={spec.pattern ?? ""}
            onChange={(e) => onChange({ ...spec, pattern: e.target.value })}
            placeholder="(?P<sku>[A-Z]+-\d+)\s+x(?P<qty>\d+)"
            spellCheck={false}
            className={cn(inputClass, "w-full")}
          />
          <div className="flex flex-wrap gap-1.5">
            <input
              aria-label={`Layout ${n}: start after`}
              value={spec.start ?? ""}
              onChange={(e) => onChange({ ...spec, start: e.target.value || undefined })}
              placeholder="Start after (optional), e.g. Items ordered"
              spellCheck={false}
              className={cn(inputClass, "flex-1 min-w-48")}
            />
            <input
              aria-label={`Layout ${n}: stop at`}
              value={spec.end ?? ""}
              onChange={(e) => onChange({ ...spec, end: e.target.value || undefined })}
              placeholder="Stop at (optional), e.g. Subtotal"
              spellCheck={false}
              className={cn(inputClass, "flex-1 min-w-48")}
            />
          </div>
          <p className="text-xs text-muted-foreground max-w-[62ch]">
            An RE2 pattern found again and again; each match is a row, its named groups the columns.
          </p>
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
  const [samples, setSamples] = useState<{ id: string; subject: string }[]>([]);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  // AI setup: a layout drafted from emails, or a field found for an open layout.
  const [aiOffered, setAiOffered] = useState(false);
  const [assist, setAssist] = useState<
    { kind: "layout" } | { kind: "field"; index: number } | null
  >(null);

  useEffect(() => {
    if (!accessToken) return;
    fetchAiAssists(accessToken, endpoint.slug)
      .then((info) => setAiOffered(info.offered))
      .catch(() => setAiOffered(false));
  }, [accessToken, endpoint.slug]);

  useEffect(() => {
    setLayouts(JSON.parse(initialKey) as Layout[]);
  }, [initialKey]);

  const draftKey = JSON.stringify(layouts);
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
      .then(
        (requests) =>
          !cancelled &&
          setSamples(
            requests.map((request) => ({
              id: request._id,
              subject: request.email?.subject || "(no subject)",
            }))
          )
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, endpoint.slug]);

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
  }, [accessToken, endpoint.slug, draftKey, local.length, sampleId]);

  const update = (index: number, change: Partial<Layout>) =>
    setLayouts(layouts.map((layout, i) => (i === index ? { ...layout, ...change } : layout)));
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
                <div className="flex flex-wrap items-center gap-2 p-2.5">
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
                    <span className="text-xs text-destructive">
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
                      className="p-1.5 text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {layoutProblems.length > 0 && (triedSave || expanded) && (
                  <p className="text-xs text-destructive px-2.5 pb-2" aria-live="polite">
                    {layoutProblems[0]}
                  </p>
                )}
                {expanded && (
                  <div className="border-t border-line/20 p-3 space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <input
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
                      <h4 className="text-sm font-semibold">Fields</h4>
                      <EmailFieldsEditor
                        slug={endpoint.slug}
                        fields={layout.fields ?? []}
                        onChange={(fields) => update(index, { fields })}
                        showRequired={triedSave}
                        emailAddress={endpoint.emailAddress ?? ""}
                        requestId={sampleId || undefined}
                      />
                      {aiOffered &&
                        (assist?.kind === "field" && assist.index === index ? (
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
                            onClick={() => setAssist({ kind: "field", index })}
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
        <p className="text-xs text-destructive" aria-live="polite">
          {listProblems[0]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => {
            setLayouts([...layouts, newLayout(layouts)]);
            setOpen(layouts.length);
          }}
          disabled={layouts.length >= MAX_LAYOUTS}
          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
        >
          <Plus className="h-3 w-3" />
          Add layout
        </button>
        {aiOffered && layouts.length < MAX_LAYOUTS && assist?.kind !== "layout" && (
          <button
            type="button"
            onClick={() => setAssist({ kind: "layout" })}
            className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
          >
            <Sparkles className="h-3 w-3" />
            Draft a layout with AI
          </button>
        )}
        {layouts.length === 0 && (
          <span className="text-xs text-muted-foreground">
            Without layouts, emails are delivered as they arrive, with your fields.
          </span>
        )}
      </div>
      {assist?.kind === "layout" && (
        <AiAssistPanel
          slug={endpoint.slug}
          samples={samples}
          mode={{ kind: "layout" }}
          onUseLayout={(drafted) => {
            const base = newLayout(layouts);
            setLayouts([
              ...layouts,
              {
                ...base,
                name: drafted.name ?? base.name,
                match: { logic: "and", conditions: drafted.match ? [drafted.match] : [] },
                fields: drafted.fields,
              },
            ]);
            setOpen(layouts.length);
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
            </div>
          ) : (
            <h3 className="text-sm font-semibold">No email yet</h3>
          )}
          {preview.request ? (
            preview.parsed ? (
              <ParsedResult parsed={preview.parsed} />
            ) : null
          ) : (
            <p className="text-xs text-muted-foreground">
              Send an email to <span className="font-mono">{endpoint.emailAddress}</span> to try the
              layouts.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
