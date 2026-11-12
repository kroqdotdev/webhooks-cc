"use client";

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Label } from "@/components/ui/label";
import { TabsList, TabsTab } from "@/components/ui/tabs";
import type { AnswerExplanation } from "@/lib/tools/answer";
import { cn } from "@/lib/utils";

/**
 * The parts the free tools share (lib/tools). What a person types into a tool
 * is theirs: every control and every place that shows it back carries
 * `ph-no-capture`, and no control has a `name`, so even a native form submit
 * (Enter before the page has hydrated) would put nothing in the URL.
 */

/**
 * The class for a control that holds a credential or the person's own content,
 * and for the block that shows a result: a provider's answer names the
 * person's channel and webhook, so analytics and recordings skip that too.
 */
export const PRIVATE_INPUT = "ph-no-capture";

/** Attributes that keep a browser from remembering or rewriting a credential. */
export const NO_MEMORY = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;

interface FieldProps {
  id: string;
  label: string;
  /** Shown under the control while there is no error. */
  hint?: ReactNode;
  error?: string | null;
  /** To the right of the label: a character count, an "optional". */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A labelled control with its hint or its error beneath. Give the control `id` and `aria-describedby={fieldNote(id)}`. */
export function Field({ id, label, hint, error, aside, children, className }: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      {children}
      {error ? (
        <p
          id={fieldNote(id)}
          role="alert"
          className={cn(PRIVATE_INPUT, "text-sm text-destructive-ink")}
        >
          {error}
        </p>
      ) : hint ? (
        <p id={fieldNote(id)} className={cn(PRIVATE_INPUT, "text-sm text-muted-foreground")}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function fieldNote(id: string): string {
  return `${id}-note`;
}

/** "1,204 / 2,000", in the error colour once over. */
export function Count({ value, max }: { value: number; max: number }) {
  return (
    <span className={cn("font-mono tabular-nums", value > max && "text-destructive-ink")}>
      {value.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
    </span>
  );
}

const TONE: Record<AnswerExplanation["outcome"], string> = {
  ok: "border-primary/40 bg-selected text-selected-foreground",
  failed: "border-destructive/50 bg-destructive/5",
  unreadable: "border-input bg-muted",
};

const ICON = {
  ok: CircleCheck,
  failed: CircleAlert,
  unreadable: CircleHelp,
} as const;

/** What happened, in words: the tool's verdict on a provider's answer or a signature. */
export function Verdict({ explanation }: { explanation: AnswerExplanation }) {
  const Icon = ICON[explanation.outcome];
  return (
    <div
      role="status"
      aria-live="polite"
      data-outcome={explanation.outcome}
      className={cn("flex gap-3 rounded-lg border p-4", TONE[explanation.outcome])}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 h-5 w-5 shrink-0",
          explanation.outcome === "failed" && "text-destructive-ink"
        )}
      />
      <div className="min-w-0 space-y-1">
        <p className="font-bold">{explanation.title}</p>
        <p className="text-sm leading-relaxed">{explanation.detail}</p>
      </div>
    </div>
  );
}

interface CodeSampleProps {
  label: string;
  code: string;
  /** Beside the label: an HTTP status. */
  aside?: ReactNode;
  testId?: string;
}

/** Text to read or copy: a provider's raw answer, a curl command, a signature. Never captured. */
export function CodeSample({ label, code, aside, testId }: CodeSampleProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        {aside ? <span className="font-mono text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      <div className={cn("relative", PRIVATE_INPUT)}>
        <CopyButton text={code} />
        <pre
          data-testid={testId}
          className="ui-code max-h-80 overflow-auto whitespace-pre-wrap break-all pr-10"
        >
          {code}
        </pre>
      </div>
    </div>
  );
}

interface ModeTabsProps<Mode extends string> {
  label: string;
  modes: readonly { value: Mode; label: string }[];
}

/** The tab bar that switches a tool between two ways of working; wrap it in `Tabs`. */
export function ModeTabs<Mode extends string>({ label, modes }: ModeTabsProps<Mode>) {
  return (
    <TabsList aria-label={label} className="flex gap-5 border-b border-border text-sm">
      {modes.map((mode) => (
        <TabsTab
          key={mode.value}
          value={mode.value}
          className="cursor-pointer whitespace-nowrap pb-2 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring not-data-active:hover:text-foreground data-active:font-medium data-active:text-foreground data-active:shadow-[inset_0_-2px_0_hsl(var(--primary))]"
        >
          {mode.label}
        </TabsTab>
      ))}
    </TabsList>
  );
}
