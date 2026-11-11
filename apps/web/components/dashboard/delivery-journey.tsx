"use client";

import { cn } from "@/lib/utils";

/**
 * A delivery as a line with stops: Sent (when the request carries the
 * sender's own timestamp), Received, and the outcome (Delivered, Try n,
 * Failed, Queued). The lag sits on the line between two stops; what the
 * destination answered sits under the outcome. Horizontal from md up,
 * vertical below. The drawing is hidden from assistive technology; the
 * whole story is the `label` sentence.
 */

export type StopTone =
  /** A time we did not measure ourselves (Sent). */
  | "hollow"
  /** Received by webhooks.cc. */
  | "solid"
  | "delivered"
  /** A try still being retried. */
  | "retrying"
  | "failed"
  /** Nothing has happened yet. */
  | "queued";

export interface JourneyStop {
  key: string;
  name: string;
  /** The exact time, in mono; left out for an estimate (see `sub`). */
  time?: string | null;
  sub?: React.ReactNode;
  tone: StopTone;
  /** The segment from this stop to the next one. */
  segment?: { label: React.ReactNode; dashed?: boolean; title?: string };
}

const DOT_TONE: Record<StopTone, string> = {
  hollow: "bg-card",
  solid: "bg-foreground border-foreground/60",
  delivered: "bg-primary border-primary",
  retrying: "bg-amber-500 border-amber-500",
  failed: "bg-destructive border-destructive",
  queued: "bg-muted border-dashed",
};

export function DeliveryJourney({
  stops,
  label,
  className,
}: {
  stops: JourneyStop[];
  /** The journey as one sentence: what a screen reader gets instead of the drawing. */
  label: string;
  className?: string;
}) {
  return (
    <div role="img" aria-label={label} className={className}>
      <div aria-hidden="true" className="flex flex-col md:flex-row md:items-start">
        {stops.map((stop, index) => {
          const last = index === stops.length - 1;
          const pulse = stop.tone === "queued" || stop.tone === "retrying";
          return (
            <div
              key={stop.key}
              className={cn(
                "relative min-w-0 pl-[22px] md:pl-0 md:pt-[34px]",
                last ? "md:flex-none md:max-w-[48%] md:pr-0" : "pb-[30px] md:pb-0 md:flex-1 md:pr-3"
              )}
            >
              <span
                className={cn(
                  "absolute left-0 top-[5px] md:top-[17px] h-2.5 w-2.5 rounded-full border border-foreground/30",
                  DOT_TONE[stop.tone],
                  pulse && "motion-safe:animate-pulse [animation-duration:1.6s]"
                )}
              />
              {!last && stop.segment && (
                <span
                  className={cn(
                    "absolute left-[5px] top-[22px] bottom-1 w-0 border-l md:border-l-0 md:w-auto md:left-[18px] md:right-2 md:top-[21px] md:bottom-auto md:border-t",
                    stop.segment.dashed
                      ? "border-dashed border-muted-foreground"
                      : "border-foreground/30"
                  )}
                  title={stop.segment.title}
                >
                  <span
                    className={cn(
                      "absolute left-[14px] bottom-1 text-left whitespace-nowrap text-[11px] leading-[14px] text-muted-foreground",
                      "md:left-0 md:right-0 md:bottom-auto md:-top-[19px] md:text-center",
                      stop.segment.dashed ? "font-sans" : "font-mono"
                    )}
                  >
                    {stop.segment.label}
                  </span>
                </span>
              )}
              <span className="block text-xs font-semibold leading-4">{stop.name}</span>
              {stop.time && (
                <span className="block font-mono text-[13px] leading-[18px]">{stop.time}</span>
              )}
              {stop.sub && (
                <span className="block text-xs leading-4 text-muted-foreground">{stop.sub}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A small round status dot, as in the health line. */
export function StatusDot({
  tone,
  className,
}: {
  tone: "delivered" | "retrying" | "failed";
  className?: string;
}) {
  return (
    <i
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        tone === "delivered" && "bg-primary",
        tone === "retrying" && "bg-amber-500",
        tone === "failed" && "bg-destructive",
        className
      )}
    />
  );
}
