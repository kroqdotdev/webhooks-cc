"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  emailFieldIssues,
  MAX_EMAIL_FIELDS,
  type EmailField,
  type EmailFieldSource,
} from "@webhooks-cc/sdk/email";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { previewEmailFields, type EmailFieldsPreview } from "@/lib/dashboard-api";

/**
 * Named fields an endpoint picks out of every email: a name, the part of the
 * email it reads, and an RE2 pattern whose first group is the value. Each
 * row shows what its pattern finds in the newest captured email as you type
 * (the server runs it, with RE2), so a pattern is right before it is saved.
 */

const SOURCES: { value: EmailFieldSource; label: string }[] = [
  { value: "subject", label: "Subject" },
  { value: "text", label: "Text" },
  { value: "html", label: "HTML, as text" },
  { value: "from", label: "From" },
  { value: "to", label: "To and Cc" },
  { value: "header", label: "A header" },
];

const selectClass = "ui-input text-[13px] py-1.5! px-2! min-w-0";
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
}: {
  slug: string;
  fields: EmailField[];
  onChange: (fields: EmailField[]) => void;
  disabled?: boolean;
  /** Show "is required" problems (after a save attempt). */
  showRequired: boolean;
  emailAddress: string;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [preview, setPreview] = useState<EmailFieldsPreview | null>(null);
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
      previewEmailFields(accessToken, slug, fields)
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // draftKey stands for `fields`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, slug, draftKey, local.length]);

  const update = (index: number, change: Partial<EmailField>) => {
    const next = fields.map((field, i) => {
      if (i !== index) return field;
      const merged = { ...field, ...change };
      if (merged.from !== "header") delete merged.header;
      return merged;
    });
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
        <ul className="space-y-2.5" aria-label="Fields">
          {fields.map((field, index) => {
            const n = index + 1;
            const problem = problems.get(index);
            const value = preview?.values?.[field.name];
            return (
              <li
                key={index}
                className="border-strong border-line rounded-md bg-card p-2.5 space-y-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    aria-label={`Field ${n}: name`}
                    value={field.name}
                    onChange={(e) => update(index, { name: e.target.value })}
                    placeholder="invoice"
                    spellCheck={false}
                    disabled={disabled}
                    className={cn(inputClass, "w-32")}
                  />
                  <span className="text-xs text-muted-foreground">from</span>
                  <select
                    aria-label={`Field ${n}: what it reads`}
                    value={field.from}
                    onChange={(e) =>
                      update(index, {
                        from: e.target.value as EmailFieldSource,
                        ...(e.target.value === "header" && !field.header
                          ? { header: "X-Mailer" }
                          : {}),
                      })
                    }
                    disabled={disabled}
                    className={cn(selectClass, "w-36")}
                  >
                    {SOURCES.map((source) => (
                      <option key={source.value} value={source.value}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                  {field.from === "header" && (
                    <input
                      aria-label={`Field ${n}: header name`}
                      value={field.header ?? ""}
                      onChange={(e) => update(index, { header: e.target.value })}
                      placeholder="X-Mailer"
                      spellCheck={false}
                      disabled={disabled}
                      className={cn(inputClass, "w-36")}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onChange(fields.filter((_, i) => i !== index))}
                    disabled={disabled}
                    aria-label={`Remove field ${field.name || n}`}
                    className="ml-auto p-1.5 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-not-allowed"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  aria-label={`Field ${n}: pattern`}
                  value={field.pattern}
                  onChange={(e) => update(index, { pattern: e.target.value })}
                  placeholder="Invoice (INV-\d+)"
                  spellCheck={false}
                  disabled={disabled}
                  className={cn(inputClass, "w-full")}
                />
                <p
                  className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}
                  aria-live="polite"
                >
                  {problem ? (
                    problem
                  ) : !preview?.request || value === undefined ? null : value ? (
                    <>
                      Finds{" "}
                      <code className="font-mono text-foreground bg-muted px-1 rounded-sm">
                        {value}
                      </code>
                    </>
                  ) : (
                    "Finds nothing in that email."
                  )}
                </p>
              </li>
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
              Tried on the newest email, &ldquo;{preview.request.subject || "(no subject)"}&rdquo;,{" "}
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
