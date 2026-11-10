"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { emitDashboardEndpointsChanged, updateDashboardEndpoint } from "@/lib/dashboard-api";
import { SectionIdentityContext, useReportDirty } from "./dirty-sections";

/**
 * The building blocks every section of the endpoint settings shares: the
 * card, a labelled field, the save footer, a switch, a segmented radio group
 * and the save hook. Kept together so the sections read the same.
 */

export const SETTINGS_SECTIONS = [
  "receiving",
  "layouts",
  "retention",
  "alerts",
  "responses",
  "forwarding",
  "deliveries",
  "sharing",
  "verification",
  "delete",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** A section id read back from the URL. */
export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "");
}

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
  // The save footer inside reports its unsaved edits under this section's name.
  const identity = useMemo(() => ({ id, title }), [id, title]);
  return (
    <SectionIdentityContext.Provider value={identity}>
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
            {/* A jump focuses the heading, so the next Tab enters this section. */}
            <h2
              id={`settings-${id}-title`}
              tabIndex={-1}
              className="text-base font-bold clean:font-semibold outline-none"
            >
              {title}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5 max-w-[62ch]">{description}</p>
          </div>
          {children}
        </div>
        {footer && (
          // A save footer with nothing to say marks itself idle and the bar folds away.
          // data-section-footer lets the panel tell when this save is in view.
          <div
            data-section-footer={id}
            className="flex flex-wrap items-center gap-3 px-5 py-3 border-t-strong border-line bg-muted/40 has-[[data-save-idle]]:hidden"
          >
            {footer}
          </div>
        )}
      </section>
    </SectionIdentityContext.Provider>
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
        <p id={errorId} className="text-xs text-destructive-ink">
          {error}
        </p>
      )}
      {help && <div className="text-[13px] text-muted-foreground space-y-1">{help}</div>}
    </div>
  );
}

/**
 * One save per section. It shows only while there is something to say: unsaved
 * edits (Cancel and Save), a save running, "Saved." after one, or an error.
 * Otherwise the footer bar folds away, so a page of untouched sections does
 * not read as a column of disabled buttons.
 */
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
  // A save started from outside the section (the sticky bar, the discard
  // dialog) clicks this footer's Save and resolves once the state says how it
  // went: an error, or saved (or no longer dirty) with nothing running.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  });
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saveFromOutside = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        // Batched with the section's own state changes from onSave, so the
        // effect below first sees this attempt's state, never the last one's.
        setAttempt((n) => n + 1);
        onSaveRef.current();
      }),
    []
  );
  useEffect(() => {
    const resolve = pending.current;
    if (!resolve || saving) return;
    if (error) {
      pending.current = null;
      resolve(false);
    } else if (saved || !dirty) {
      pending.current = null;
      resolve(true);
    }
  }, [attempt, dirty, saving, error, saved]);
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    []
  );
  useReportDirty(dirty, saveFromOutside);
  const idle = !dirty && !saving && !saved && !error;
  // A failed save leaves the edits, so Save stays for a retry.
  const showSave = dirty || saving;
  return (
    <>
      {idle && <span data-save-idle hidden />}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "text-xs flex-1 min-w-[180px]",
          error ? "text-destructive-ink" : "text-muted-foreground"
        )}
      >
        {error ?? (dirty ? hint : saved ? "Saved." : "")}
      </p>
      {dirty && (
        <button type="button" onClick={onReset} className="ui-btn-outline py-1.5! px-3! text-xs">
          Cancel
        </button>
      )}
      {showSave && (
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
      )}
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
        // Off, clean's track takes the control boundary colour so it reads at 3:1.
        checked ? "bg-primary" : "bg-muted clean:border-input"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 border-strong border-line rounded-sm clean:rounded-full transition-transform motion-reduce:transition-none",
          checked
            ? "translate-x-5.5 bg-card"
            : "translate-x-0.5 bg-card clean:bg-muted-foreground/70"
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
          <p id={`${id}-help`} className="text-[13px] text-muted-foreground mt-1 max-w-[62ch]">
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
  // More than three choices do not fit a phone's width side by side, and a
  // scrolling strip hides some of them, so they stack there instead.
  const stack = options.length > 3;
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn(
        "inline-flex max-w-full overflow-x-auto [scrollbar-width:none] rounded-sm border-strong border-line bg-background",
        stack && "max-sm:flex max-sm:flex-col max-sm:w-full",
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
              size === "sm" ? "px-3 py-1.5 text-xs" : "px-2.5 py-1 text-[11px]",
              index > 0 && "border-l-strong border-line",
              stack && "max-sm:text-left",
              stack && index > 0 && "max-sm:border-l-0 max-sm:border-t-strong",
              // Clean's selected tint alone is too faint (WCAG 1.4.11), so the
              // choice also gets a primary underline, or a side bar when stacked.
              checked
                ? cn(
                    "bg-selected text-selected-foreground clean:shadow-[inset_0_-2px_0_hsl(var(--primary))]",
                    stack && "max-sm:clean:shadow-[inset_3px_0_0_hsl(var(--primary))]"
                  )
                : "hover:bg-muted"
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

/** How long after arming a confirmation a press on it still counts as the arming one. */
const CONFIRM_SETTLE_MS = 600;

/**
 * A destructive action confirmed in a second step. The first press arms it and
 * moves focus to the button that backs out, which the caller renders where the
 * arming button was. Presses within 600 ms of arming are ignored on both
 * buttons, so a double-click or a double Enter neither confirms nor cancels.
 */
export function useConfirmStep() {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const arm = useCallback(() => {
    armedAt.current = Date.now();
    setArmed(true);
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);
  /** False while a press is too soon after arming to be a decision. */
  const settled = useCallback(() => Date.now() - armedAt.current >= CONFIRM_SETTLE_MS, []);
  const cancel = useCallback(() => {
    if (settled()) setArmed(false);
  }, [settled]);
  const reset = useCallback(() => setArmed(false), []);
  return { armed, arm, cancel, reset, settled, cancelRef };
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

/**
 * Scrolls a settings section into view (no smooth scroll under reduced motion)
 * and moves focus to its heading, so the next Tab lands inside the section.
 */
export function scrollToSection(id: SettingsSection, { smooth = true }: { smooth?: boolean } = {}) {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  document
    .getElementById(`settings-${id}`)
    ?.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" });
  document.getElementById(`settings-${id}-title`)?.focus({ preventScroll: true });
}
