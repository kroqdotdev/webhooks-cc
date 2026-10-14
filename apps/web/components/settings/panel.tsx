import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Inline links in settings copy: foreground with an underline, readable in every style. */
export const settingsLink =
  "font-medium text-foreground underline underline-offset-2 decoration-muted-foreground hover:decoration-foreground";

/**
 * Building blocks for the account and team settings pages: the page heading,
 * a panel with an optional footer for its actions, and a labelled row. They
 * use the style-aware classes only, so classic and clean both render them.
 */

export function SettingsPageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold clean:font-semibold break-words">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground max-w-[60ch]">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Panel({
  id,
  title,
  description,
  actions,
  footer,
  tone,
  flush,
  children,
  className,
  testId,
}: {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Controls beside the title, such as a create button. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "danger";
  /** Drops the body padding, for tables and lists that run edge to edge. */
  flush?: boolean;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const titleId = id ? `${id}-title` : undefined;
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn(
        "ui-card ui-card-static p-0! overflow-hidden scroll-mt-20",
        tone === "danger" && "border-destructive",
        className
      )}
    >
      {(title || actions) && (
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-3 px-5 pt-5",
            !hasBody ? "pb-5" : flush ? "pb-4 border-b-strong border-line" : "pb-0"
          )}
        >
          <div className="min-w-0 space-y-0.5">
            {title && (
              <h2
                id={titleId}
                className={cn(
                  "text-base font-bold clean:font-semibold",
                  tone === "danger" && "text-destructive"
                )}
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="text-sm text-muted-foreground max-w-[62ch]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {hasBody && <div className={flush ? "" : "p-5"}>{children}</div>}
      {footer && (
        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-t-strong border-line bg-muted/40">
          {footer}
        </div>
      )}
    </section>
  );
}

/** A label on the left, its value or control on the right; stacks on narrow screens. */
export function PanelRow({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6 border-b border-line/60 last:border-b-0">
      <div className="space-y-0.5">
        <Label htmlFor={htmlFor} className="text-sm font-medium block">
          {label}
        </Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/** A one-line result under a form: green for done, amber for a caveat, red for a failure. */
export function InlineMessage({
  tone,
  children,
}: {
  tone: "success" | "warning" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "text-sm",
        tone === "success" && "text-green-700 dark:text-green-400",
        tone === "warning" && "text-amber-700 dark:text-amber-400",
        tone === "error" && "text-destructive"
      )}
    >
      {children}
    </p>
  );
}

/** A full-width notice above a page's panels, for states that change what the page can do. */
export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: "info" | "warning" | "danger" | "success";
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-md border-strong p-4",
        tone === "info" && "border-line bg-muted/50",
        tone === "warning" && "border-amber-500/60 bg-amber-500/10",
        tone === "danger" && "border-destructive/60 bg-destructive/10",
        tone === "success" && "border-green-600/50 bg-green-500/10"
      )}
    >
      <div className="min-w-0 space-y-1">
        <p
          className={cn(
            "text-sm font-semibold",
            tone === "warning" && "text-amber-800 dark:text-amber-300",
            tone === "danger" && "text-destructive",
            tone === "success" && "text-green-800 dark:text-green-300"
          )}
        >
          {title}
        </p>
        {children && <div className="text-sm text-muted-foreground max-w-[64ch]">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Placeholder shaped like a settings page while its data loads. */
export function SettingsPageSkeleton({ label, panels = 2 }: { label: string; panels?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48 rounded-md" />
        <Skeleton className="h-4 w-80 max-w-full rounded-md" />
      </div>
      <div className="space-y-6">
        {Array.from({ length: panels }, (_, index) => (
          <div key={index} className="ui-card ui-card-static space-y-4 p-5!">
            <Skeleton className="h-5 w-40 rounded-md" />
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-2/3 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A short state label, such as a role or a subscription status. */
export function StatusTag({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "neutral" && "border-line text-foreground",
        tone === "success" && "border-green-600/50 text-green-800 dark:text-green-300",
        tone === "warning" && "border-amber-500/60 text-amber-800 dark:text-amber-300",
        tone === "danger" && "border-destructive/60 text-destructive"
      )}
    >
      {children}
    </span>
  );
}
