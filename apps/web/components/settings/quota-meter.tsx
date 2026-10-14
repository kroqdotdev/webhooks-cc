"use client";

import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";

/** Who holds a seat in a team's rail. */
export type SeatSlot =
  | { kind: "member"; name: string | null; email: string; image: string | null; isYou?: boolean }
  | { kind: "invite"; email: string }
  | { kind: "open" };

/** Above this many seats the rail drops its per-seat labels and summarises instead. */
const LABELLED_SEAT_LIMIT = 10;

/** Above this many seats per-seat blocks no longer fit the column, so the rail is one bar. */
const SEAT_BLOCK_LIMIT = 40;

/** How much of [start, end) the range [from, to) covers, as a fraction of the block. */
function overlap(start: number, end: number, from: number, to: number): number {
  const size = end - start;
  if (size <= 0) return 0;
  return Math.max(0, Math.min(end, to) - Math.max(start, from)) / size;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Request usage drawn as capacity. With `seats`, the bar splits into one block
 * per seat, each worth an equal share of the pooled limit, so adding a seat
 * visibly adds a block of requests; usage fills the blocks left to right, HTTP
 * first and email after it. Without seats it is a single block.
 */
export function QuotaMeter({
  used,
  limit,
  emails = 0,
  seats,
  seatsEndingFrom,
  caption,
  compact = false,
  label,
}: {
  used: number;
  limit: number;
  /** Emails among `used`; drawn in the email colour after the HTTP share. */
  emails?: number;
  seats?: SeatSlot[];
  /** Index of the first seat a scheduled reduction removes at renewal. */
  seatsEndingFrom?: number | null;
  /** A line under the numbers, such as when the period resets. */
  caption?: React.ReactNode;
  /** A slim bar with no labels, for lists. */
  compact?: boolean;
  /** What the numbers count, for screen readers and the heading line. */
  label?: string;
}) {
  const safeLimit = Math.max(limit, 0);
  const shownUsed = Math.max(0, Math.min(used, safeLimit || used));
  const shownEmails = Math.max(0, Math.min(emails, shownUsed));
  const httpEnd = shownUsed - shownEmails;
  const percent = safeLimit > 0 ? Math.min((used / safeLimit) * 100, 100) : 0;
  const nearLimit = percent >= 80;

  const perSeat = seats !== undefined && seats.length > 0 && seats.length <= SEAT_BLOCK_LIMIT;
  const blocks = perSeat ? seats : [null];
  const perBlock = safeLimit / blocks.length;
  const labelled = !compact && seats !== undefined && seats.length <= LABELLED_SEAT_LIMIT;
  const what = label ?? "requests";

  const summary = seats
    ? [
        plural(seats.filter((s) => s.kind === "member").length, "member", "members"),
        seats.some((s) => s.kind === "invite")
          ? plural(seats.filter((s) => s.kind === "invite").length, "invited", "invited")
          : null,
        plural(seats.filter((s) => s.kind === "open").length, "open seat", "open seats"),
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <div className={cn(compact ? "space-y-1.5" : "space-y-3")}>
      {!compact && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm">
            <span
              className={cn(
                "text-2xl font-bold clean:font-semibold tabular-nums",
                nearLimit && "text-destructive"
              )}
            >
              {used.toLocaleString()}
            </span>{" "}
            <span className="text-muted-foreground">
              of {safeLimit.toLocaleString()} {what}
            </span>
          </p>
          {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
        </div>
      )}

      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${used.toLocaleString()} of ${safeLimit.toLocaleString()} ${what} used`}
        className={cn("flex", compact ? "gap-0.5" : "gap-1")}
      >
        {blocks.map((_, index) => {
          const start = index * perBlock;
          const end = start + perBlock;
          const httpShare = overlap(start, end, 0, httpEnd);
          const emailShare = overlap(start, end, httpEnd, shownUsed);
          const ending =
            perSeat &&
            seatsEndingFrom !== null &&
            seatsEndingFrom !== undefined &&
            index >= seatsEndingFrom;
          return (
            <div
              key={index}
              aria-hidden="true"
              className={cn(
                "relative flex-1 min-w-0 overflow-hidden rounded-sm bg-muted/60",
                compact ? "h-2" : perSeat ? "h-9 border-strong border-line" : "h-3",
                ending && "opacity-50 border-dashed"
              )}
            >
              <div className="absolute inset-y-0 left-0 flex w-full">
                <div
                  className={cn("h-full", nearLimit ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${httpShare * 100}%` }}
                />
                <div className="h-full bg-kind-email" style={{ width: `${emailShare * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {labelled && seats && (
        <ul className="flex gap-1" aria-label="Seats">
          {seats.map((seat, index) => {
            const ending =
              seatsEndingFrom !== null && seatsEndingFrom !== undefined && index >= seatsEndingFrom;
            return (
              <li key={index} className="flex-1 min-w-0 flex items-center gap-1.5 text-xs">
                {seat.kind === "member" ? (
                  <>
                    <Avatar name={seat.name} email={seat.email} image={seat.image} size="sm" />
                    <span
                      className="sr-only truncate sm:not-sr-only"
                      title={seat.name ?? seat.email}
                    >
                      {seat.isYou
                        ? "You"
                        : (seat.name?.split(/\s+/)[0] ?? seat.email.split("@")[0])}
                    </span>
                  </>
                ) : seat.kind === "invite" ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="h-6 w-6 shrink-0 rounded-full border border-dashed border-muted-foreground"
                    />
                    <span
                      className="sr-only truncate text-muted-foreground sm:not-sr-only"
                      title={seat.email}
                    >
                      Invited
                    </span>
                  </>
                ) : (
                  <span className="sr-only truncate text-muted-foreground sm:not-sr-only">
                    {ending ? "Removed at renewal" : "Open seat"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!compact && summary && (
        // Narrow screens hide the per-seat names, so the summary stands in for them.
        <p className={cn("text-xs text-muted-foreground", labelled && "sm:hidden")}>{summary}</p>
      )}

      {!compact && shownEmails > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block h-2 w-2 rounded-sm",
                nearLimit ? "bg-destructive" : "bg-primary"
              )}
            />
            HTTP <span className="font-medium text-foreground">{httpEnd.toLocaleString()}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-kind-email" />
            Email{" "}
            <span className="font-medium text-foreground">{shownEmails.toLocaleString()}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Fills a team's seats in the order people hold them: members, then pending
 * invites (an invite does not reserve a seat, it only shows who may take one),
 * then open seats. Invites beyond the free seats are left out of the rail.
 */
export function seatSlotsFor(
  seatCount: number,
  members: { name: string | null; email: string; image: string | null; userId: string }[],
  invites: { invitedEmail: string }[],
  currentUserId: string | null
): SeatSlot[] {
  const slots: SeatSlot[] = members.slice(0, seatCount).map((member) => ({
    kind: "member",
    name: member.name,
    email: member.email,
    image: member.image,
    isYou: member.userId === currentUserId,
  }));
  for (const invite of invites) {
    if (slots.length >= seatCount) break;
    slots.push({ kind: "invite", email: invite.invitedEmail });
  }
  while (slots.length < seatCount) slots.push({ kind: "open" });
  return slots;
}
