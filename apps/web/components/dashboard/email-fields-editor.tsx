"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import {
  emailFieldIssues,
  MAX_EMAIL_FIELDS,
  type EmailField,
  type EmailFieldSource,
} from "@webhooks-cc/sdk/email";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { previewEmailFields, type EmailFieldsPreview } from "@/lib/dashboard-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Named fields an endpoint picks out of every email: a name, the part of the
 * email it reads, and an RE2 pattern whose first group is the value. Each
 * row leads with what its pattern finds in the newest captured email (the
 * server runs it, with RE2); the pattern itself sits behind "Edit pattern",
 * open while the field is new, finds nothing or has a problem.
 */

const SOURCES: { value: EmailFieldSource; label: string }[] = [
  { value: "subject", label: "Subject" },
  { value: "text", label: "Text" },
  { value: "html", label: "HTML, as text" },
  { value: "from", label: "From" },
  { value: "to", label: "To and Cc" },
  { value: "header", label: "A header" },
];

const selectClass =
  "h-auto w-32 min-w-0 gap-1.5 text-[13px] rounded-md border border-border bg-background px-2 py-1.5 text-left cursor-pointer focus:ring-offset-0";
// No ligatures: a pattern's "<=" must not read as "≤".
const inputClass =
  "ui-input text-[13px] font-mono [font-variant-ligatures:none] py-1.5! px-2! min-w-0";

/** The problems of one row ("field 2: ..." becomes "..."), for showing beside it. */
function problemsByRow(problems: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const problem of problems) {
    const match = /^field (\d+): (.*)$/.exec(problem);
    if (match && !out.has(Number(match[1]) - 1)) out.set(Number(match[1]) - 1, match[2]);
  }
  return out;
}

/** A new field's name: "field", "field2", ... whichever is free. */
function freeName(fields: EmailField[]): string {
  const taken = new Set(fields.map((field) => field.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "field" : `field${n}`;
    if (!taken.has(name)) return name;
  }
}

function formatAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function EmailFieldsEditor({
  slug,
  fields,
  onChange,
  disabled,
  showRequired,
  emailAddress,
  requestId,
  refreshKey,
  layoutUnmatched,
}: {
  slug: string;
  fields: EmailField[];
  onChange: (fields: EmailField[]) => void;
  disabled?: boolean;
  /** Show "is required" problems (after a save attempt). */
  showRequired: boolean;
  emailAddress: string;
  /** Try the fields on this email instead of the newest. */
  requestId?: string;
  /** Changed when an email arrived that the preview should read (one sent from the page). */
  refreshKey?: number;
  /**
   * The layout these fields belong to does not apply to the email tried, so a
   * field finding nothing there is expected: rows show no value and no miss.
   */
  layoutUnmatched?: boolean;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [preview, setPreview] = useState<EmailFieldsPreview | null>(null);
  // Rows whose pattern was opened or closed by hand, by place; the rest
  // follow their default (open while there is something to fix).
  const [patternOpen, setPatternOpen] = useState<Record<number, boolean>>({});
  const baseId = useId();
  const local = useMemo(() => emailFieldIssues(fields), [fields]);
  const shownLocal = local.filter((problem) => showRequired || !problem.includes("is required"));
  const problems = problemsByRow([...shownLocal, ...(preview?.problems ?? [])]);

  // Tried on the newest email as the fields change, once they make sense.
  // Problems from an earlier draft name rows by place, so they go at once.
  const draftKey = JSON.stringify(fields);
  useEffect(() => {
    setPreview((previous) =>
      previous && previous.problems.length > 0 ? { ...previous, problems: [] } : previous
    );
  }, [draftKey]);
  useEffect(() => {
    if (!accessToken || fields.length === 0 || local.length > 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      previewEmailFields(accessToken, slug, fields, requestId)
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // draftKey stands for `fields`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, slug, draftKey, local.length, requestId, refreshKey]);

  const update = (index: number, change: Partial<EmailField>) => {
    const next = fields.map((field, i) => {
      if (i !== index) return field;
      const merged = { ...field, ...change };
      if (merged.from !== "header") delete merged.header;
      return merged;
    });
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
    // Rows below move up one place, and their open patterns with them.
    setPatternOpen((current) => {
      const next: Record<number, boolean> = {};
      for (const [key, value] of Object.entries(current)) {
        const i = Number(key);
        if (i < index) next[i] = value;
        else if (i > index) next[i - 1] = value;
      }
      return next;
    });
  };

  const notFound = requestId ? "Not found in this email" : "Not found in the newest email";

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
        <ul className="space-y-2" aria-label="Fields">
          {fields.map((field, index) => {
            const n = index + 1;
            const problem = problems.get(index);
            const value = preview?.values?.[field.name];
            const missing =
              !layoutUnmatched && Boolean(preview?.request) && value !== undefined && !value;
            // Open by default where there is something to do with the pattern.
            const open =
              patternOpen[index] ?? (!field.pattern.trim() || Boolean(problem) || missing);
            const patternId = `${baseId}-pattern-${index}`;
            const label = field.name || `field ${n}`;
            return (
              <Collapsible
                key={index}
                open={open}
                onOpenChange={(next) =>
                  setPatternOpen((current) => ({ ...current, [index]: next }))
                }
                render={<li className="border border-border rounded-md bg-card p-2.5" />}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <input
                    aria-label={`Field ${n}: name`}
                    value={field.name}
                    onChange={(e) => update(index, { name: e.target.value })}
                    placeholder="invoice"
                    spellCheck={false}
                    disabled={disabled}
                    className={cn(inputClass, "w-32 font-semibold")}
                  />
                  <span className="text-xs text-muted-foreground">from</span>
                  <Select
                    value={field.from}
                    onValueChange={(value) =>
                      update(index, {
                        from: value as EmailFieldSource,
                        ...(value === "header" && !field.header ? { header: "X-Mailer" } : {}),
                      })
                    }
                    disabled={disabled}
                  >
                    <SelectTrigger aria-label={`Field ${n}: what it reads`} className={selectClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border border-border shadow-float">
                      {SOURCES.map((source) => (
                        <SelectItem key={source.value} value={source.value} className="text-[13px]">
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {field.from === "header" && (
                    <input
                      aria-label={`Field ${n}: header name`}
                      value={field.header ?? ""}
                      onChange={(e) => update(index, { header: e.target.value })}
                      placeholder="X-Mailer"
                      spellCheck={false}
                      disabled={disabled}
                      className={cn(inputClass, "w-32")}
                    />
                  )}
                  <span className="flex-1 min-w-40 text-[13px] break-all" aria-live="polite">
                    {/* Without an email, the one line under the rows says so, not every row;
                        for a layout that does not apply to the email, a miss is expected. */}
                    {problem ||
                    !preview?.request ||
                    layoutUnmatched ||
                    value === undefined ? null : value ? (
                      <code className="font-mono text-foreground [font-variant-ligatures:none]">
                        {value}
                      </code>
                    ) : (
                      <span className="text-xs text-destructive-ink">{notFound}</span>
                    )}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    <EditPatternTrigger aria-label={`Edit pattern for ${label}`} />
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={disabled}
                      aria-label={`Remove field ${label}`}
                      className="p-1.5 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-not-allowed"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <CollapsiblePanel keepMounted className="pt-2 space-y-1">
                  <label
                    htmlFor={`${patternId}-input`}
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    Pattern (RE2)
                  </label>
                  <input
                    id={`${patternId}-input`}
                    aria-label={`Field ${n}: pattern (RE2)`}
                    value={field.pattern}
                    // Typing keeps the pattern open, even once it finds a value.
                    onFocus={() => setPatternOpen((current) => ({ ...current, [index]: true }))}
                    onChange={(e) => update(index, { pattern: e.target.value })}
                    placeholder="Invoice (INV-\d+)"
                    spellCheck={false}
                    disabled={disabled}
                    className={cn(inputClass, "w-full")}
                  />
                </CollapsiblePanel>
                <p
                  className={cn("text-xs text-destructive-ink", problem && "pt-1.5")}
                  aria-live="polite"
                >
                  {problem}
                </p>
              </Collapsible>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() =>
            onChange([...fields, { name: freeName(fields), from: "subject", pattern: "" }])
          }
          disabled={disabled || fields.length >= MAX_EMAIL_FIELDS}
          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
        >
          <Plus className="h-3 w-3" />
          Add field
        </button>
        {fields.length > 0 &&
          (preview?.request ? (
            <span className="text-xs text-muted-foreground">
              Tried on {requestId ? "the email" : "the newest email"}, &ldquo;
              {preview.request.subject || "(no subject)"}&rdquo;,{" "}
              {formatAgo(preview.request.receivedAt)}.
            </span>
          ) : preview ? (
            <span className="text-xs text-muted-foreground">
              Send an email to <span className="font-mono">{emailAddress}</span> to try them.
            </span>
          ) : null)}
      </div>
    </div>
  );
}

/** "Edit pattern", its chevron turned while the pattern shows. Inside a Collapsible. */
export function EditPatternTrigger({
  className,
  ...props
}: {
  "aria-label": string;
  className?: string;
}) {
  return (
    <CollapsibleTrigger
      {...props}
      className={cn(
        "group inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer",
        className
      )}
    >
      Edit pattern
      <ChevronDown
        className="h-3 w-3 transition-transform group-data-panel-open:rotate-180"
        aria-hidden
      />
    </CollapsibleTrigger>
  );
}
