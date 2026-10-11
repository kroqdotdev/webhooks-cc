"use client";

import { useCallback, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { emitDashboardEndpointsChanged, updateDashboardEndpoint } from "@/lib/dashboard-api";

/**
 * The building blocks every section of the endpoint settings shares: the
 * card, a labelled field, the save footer, a switch, a segmented radio group
 * and the save hook. Kept together so the sections read the same.
 */

export type SettingsSection =
  | "receiving"
  | "responses"
  | "forwarding"
  | "deliveries"
  | "notifications"
  | "sharing"
  | "verification"
  | "delete";

export function Section({
  id,
  title,
  description,
  children,
  footer,
  danger,
  sectionRef,
}: {
  id: SettingsSection;
  title: string;
  description: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  danger?: boolean;
  sectionRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      ref={sectionRef}
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-title`}
      data-settings-section={id}
      className={cn(
        "ui-card ui-card-static p-0! scroll-mt-4 overflow-hidden",
        danger && "border-destructive"
      )}
    >
      <div className="p-5 space-y-4">
        <div>
          <h2 id={`settings-${id}-title`} className="text-base font-bold clean:font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-[62ch]">{description}</p>
        </div>
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-t-strong border-line bg-muted/40">
          {footer}
        </div>
      )}
    </section>
  );
}

export function Field({
  id,
  label,
  labelId,
  help,
  error,
  errorId,
  children,
  className,
}: {
  /** The control's id; the label points at it. Leave out for a group. */
  id?: string;
  label: string;
  /** An id for the label itself, for aria-labelledby on a group. */
  labelId?: string;
  help?: React.ReactNode;
  /** Shown under the control in the destructive colour. */
  error?: React.ReactNode;
  errorId?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const Label = id ? "label" : "span";
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} id={labelId} className="block text-xs font-bold caps">
        {label}
      </Label>
      {children}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
      {help && <div className="text-xs text-muted-foreground space-y-1">{help}</div>}
    </div>
  );
}

/** One save per section: disabled until something in it changes. */
export function SaveFooter({
  dirty,
  saving,
  error,
  saved,
  hint,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
  hint: string;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-xs flex-1 min-w-[180px]",
          error ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {error ?? (dirty ? hint : saved ? "Saved." : "")}
      </p>
      {dirty && (
        <button type="button" onClick={onReset} className="ui-btn-outline py-1.5! px-3! text-xs">
          Cancel
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving}
        className={cn(
          "ui-btn-primary py-1.5! px-3! text-xs",
          (!dirty || saving) && "opacity-50 cursor-not-allowed"
        )}
      >
        {saving ? "Saving..." : "Save changes"}
      </button>
    </>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center border-strong border-line rounded-lg cursor-pointer transition-colors motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "clean:rounded-full",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 bg-card border-strong border-line rounded-sm clean:rounded-full transition-transform motion-reduce:transition-none",
          checked ? "translate-x-5.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

/** A switch with its label and help beside it, the settings' usual row. */
export function SwitchRow({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-semibold">
          {label}
        </label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground mt-1 max-w-[62ch]">
            {help}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onChange={onChange}
        label={label}
        disabled={disabled}
        describedBy={help ? `${id}-help` : undefined}
      />
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A live count shown after the label, as in the log's filters. */
  count?: number | string;
}

/**
 * The segmented control (the JSON pane's Formatted | Tree pattern) as a
 * radio group: one tab stop, arrow keys move the choice, Home and End jump.
 */
export function Segmented<T extends string>({
  name,
  value,
  onChange,
  options,
  size = "sm",
  className,
}: {
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "xs";
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = options.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].value);
    const group = event.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn(
        "inline-flex max-w-full overflow-x-auto [scrollbar-width:none] rounded-sm border-strong border-line bg-background",
        className
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "font-bold caps whitespace-nowrap cursor-pointer transition-colors motion-reduce:transition-none",
              size === "sm" ? "px-3 py-1.5 text-xs" : "px-2 py-0.5 text-[10px]",
              index > 0 && "border-l-strong border-line",
              checked ? "bg-selected text-selected-foreground" : "hover:bg-muted"
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <>
                {" "}
                <span className="ml-1 font-mono font-normal opacity-70">{option.count}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function useSave(slug: string) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useCallback(
    async (updates: Record<string, unknown>, validate?: () => void) => {
      setError(null);
      setSaved(false);
      try {
        validate?.();
        if (!accessToken) throw new Error("Sign in again to save changes.");
        setSaving(true);
        await updateDashboardEndpoint(accessToken, slug, updates);
        emitDashboardEndpointsChanged();
        setSaved(true);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "The changes were not saved.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [accessToken, slug]
  );
  return { save, saving, error, saved, setError, setSaved };
}

/** Scrolls a settings section into view; no smooth scroll under reduced motion. */
export function scrollToSection(id: SettingsSection) {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document
    .getElementById(`settings-${id}`)
    ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}
