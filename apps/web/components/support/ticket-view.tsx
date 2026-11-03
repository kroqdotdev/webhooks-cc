"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, ApiError, shortDateTime, shortDay, timeAgo } from "@/lib/support/client";
import { BODY_MAX, categoryLabel, type SupportTicketDetail } from "@/lib/support/shared";
import { subscribeToSupportTickets } from "@/lib/supabase/realtime";
import { cn } from "@/lib/utils";
import { CheckRow, Conversation, ImagePicker, supportBody, TurnLine } from "./thread";

function turnSentence(ticket: SupportTicketDetail): string {
  if (ticket.status === "closed") {
    const reopen = ticket.reopenableUntil && new Date(ticket.reopenableUntil) > new Date();
    return reopen
      ? `Closed ${shortDay(ticket.closedAt!)}. Answer below by ${shortDay(ticket.reopenableUntil!)} to open it again.`
      : `Closed ${shortDay(ticket.closedAt!)}. Open a new ticket if you need more help.`;
  }
  if (ticket.waitingOn === "user") {
    const closes = ticket.autoCloseAt
      ? ` If there is nothing more, it closes on its own on ${shortDay(ticket.autoCloseAt)}.`
      : "";
    return `Support replied ${timeAgo(ticket.waitingSince)} and is waiting for your answer.${closes}`;
  }
  return `You wrote ${timeAgo(ticket.lastMessageAt)}. Support answers here${ticket.notifyEmail ? " and by email" : ""}.`;
}

function Rating({
  ticket,
  onRate,
  initial,
}: {
  ticket: SupportTicketDetail;
  onRate: (rating: number, comment: string) => Promise<void>;
  initial: number | null;
}) {
  const [rating, setRating] = useState<number | null>(ticket.rating ?? initial);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(ticket.rating !== null);
  const [saving, setSaving] = useState(false);

  if (saved) {
    return (
      <p className="text-sm text-muted-foreground">
        You rated this {ticket.rating ?? rating} out of 5. Thank you.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">How did we do?</p>
      <div
        className="flex gap-1.5"
        role="radiogroup"
        aria-label="Rating from 1 (poor) to 5 (great)"
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            onClick={() => setRating(value)}
            className={cn(
              "h-9 w-9 rounded-md border text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              rating === value
                ? "border-primary/40 bg-selected font-semibold text-selected-foreground"
                : "border-input hover:bg-muted"
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">1 is poor, 5 is great.</p>
      {rating !== null && (
        <>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Anything we should know? (optional)"
          />
          <Button
            size="sm"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onRate(rating, comment);
                setSaved(true);
              } finally {
                setSaving(false);
              }
            }}
          >
            Send rating
          </Button>
        </>
      )}
    </div>
  );
}

export function TicketView({ number }: { number: string }) {
  const { session } = useAuth();
  const token = session?.access_token ?? null;
  const userId = session?.user.id ?? null;
  const params = useSearchParams();
  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reply, setReply] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    params.get("images") === "failed"
      ? "Your ticket was sent, but some screenshots could not be saved. Attach them to a reply."
      : null
  );
  const [attachments, setAttachments] = useState(false);
  const rateParam = Number(params.get("rate"));
  const initialRating =
    Number.isInteger(rateParam) && rateParam >= 1 && rateParam <= 5 ? rateParam : null;

  const load = useCallback(async () => {
    try {
      setTicket(await apiFetch<SupportTicketDetail>(token, `/api/support/tickets/${number}`));
      setError(null);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) setNotFound(true);
      else
        setError(
          loadError instanceof Error ? loadError.message : "The ticket could not be loaded."
        );
    }
  }, [token, number]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    void apiFetch<{ attachments: boolean }>(token, "/api/support/tickets")
      .then((data) => setAttachments(data.attachments))
      .catch(() => setAttachments(false));
  }, [token]);

  useEffect(() => {
    if (!userId) return;
    return subscribeToSupportTickets(userId, () => void load());
  }, [userId, load]);

  const patch = async (json: Record<string, unknown>) => {
    try {
      const fresh = await apiFetch<SupportTicketDetail>(token, `/api/support/tickets/${number}`, {
        method: "PATCH",
        json,
      });
      if (fresh) setTicket(fresh);
      setError(null);
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "The change could not be saved.");
    }
  };

  const send = async () => {
    if (!reply.trim() && images.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const { body, json } = supportBody({ body: reply }, images);
      const response = await fetch(`/api/support/tickets/${number}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
      const data = (await response.json().catch(() => ({}))) as {
        ticket?: SupportTicketDetail;
        error?: string;
        imagesFailed?: number;
      };
      if (!response.ok) throw new Error(data.error ?? "The reply could not be sent.");
      if (data.ticket) setTicket(data.ticket);
      setReply("");
      setImages([]);
      setNotice(
        data.imagesFailed ? "Your reply was sent, but some screenshots could not be saved." : null
      );
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The reply could not be sent.");
    } finally {
      setSending(false);
    }
  };

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-6 pb-16 pt-10 md:px-10">
        <h1 className="mb-2 text-2xl font-bold clean:font-semibold">No such ticket</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Ticket #{number} is not one of yours. It may belong to another account you use.
        </p>
        <Button asChild variant="outline">
          <Link href="/support">See your tickets</Link>
        </Button>
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className="mx-auto max-w-3xl px-6 pb-16 pt-10 md:px-10">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div role="status" aria-label="Loading the ticket" className="space-y-3">
            <Skeleton className="h-8 w-2/3 rounded-md" />
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </div>
        )}
      </main>
    );
  }

  const closed = ticket.status === "closed";
  const canReply =
    !closed || (ticket.reopenableUntil !== null && new Date(ticket.reopenableUntil) > new Date());

  return (
    <main className="mx-auto max-w-5xl px-6 pb-16 pt-10 md:px-10">
      <p className="mb-2 text-xs text-muted-foreground">
        <Link href="/support" className="text-primary hover:underline">
          Support
        </Link>{" "}
        / <span className="font-mono">#{ticket.number}</span>
      </p>
      <h1 className="ph-no-capture mb-4 max-w-[40ch] text-2xl font-bold clean:font-semibold md:text-3xl">
        {ticket.subject}
      </h1>
      <TurnLine waitingOn={ticket.waitingOn} closed={closed} left="You" right="Support" />
      <p className="mb-8 mt-2 text-sm">{turnSentence(ticket)}</p>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-6">
          <Conversation messages={ticket.messages} audience="user" token={token} />

          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

          {canReply && (
            <div className="ui-card ui-card-static space-y-3 p-3!">
              <label htmlFor="reply" className="sr-only">
                Your reply
              </label>
              <Textarea
                id="reply"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                rows={4}
                maxLength={BODY_MAX}
                placeholder={closed ? "Write to open this ticket again" : "Write a reply"}
                className="ph-no-capture border-0 bg-transparent px-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
                }}
              />
              {attachments && (
                <ImagePicker files={images} onChange={setImages} disabled={sending} />
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-xs text-muted-foreground">Markdown works.</span>
                <div className="flex gap-2">
                  {!closed && (
                    <Button variant="outline" size="sm" onClick={() => void patch({ close: true })}>
                      Close ticket
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={sending || (!reply.trim() && images.length === 0)}
                    onClick={() => void send()}
                  >
                    {sending ? "Sending..." : closed ? "Send and reopen" : "Send reply"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {closed && (
            <div className="ui-card ui-card-static">
              <Rating
                ticket={ticket}
                initial={initialRating}
                onRate={(rating, comment) => patch({ rating, ratingComment: comment })}
              />
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="ui-card ui-card-static space-y-2">
            <h2 className="text-sm font-semibold">Email updates</h2>
            <CheckRow
              id="notify-email"
              checked={ticket.notifyEmail}
              onChange={(value) => void patch({ notifyEmail: value })}
              title="Email me on replies and when it closes"
            />
          </section>

          <section className="ui-card ui-card-static space-y-2">
            <h2 className="text-sm font-semibold">Support access</h2>
            {ticket.accessActive ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Support can view your account read-only
                  {closed && ticket.accessEndsAt
                    ? ` until ${shortDateTime(ticket.accessEndsAt)}.`
                    : " until 7 days after this ticket closes."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void patch({ accessGranted: false })}
                >
                  Withdraw access
                </Button>
              </>
            ) : closed ? (
              <p className="text-sm text-muted-foreground">Support cannot view your account.</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Support cannot view your account. Giving access lets support read your endpoints,
                  captured requests and emails, read-only, while this ticket is open.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void patch({ accessGranted: true })}
                >
                  Give access
                </Button>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              <Link href="/account/support-access" className="underline underline-offset-2">
                See when support looked
              </Link>
            </p>
          </section>

          <section className="ui-card ui-card-static">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Topic</dt>
              <dd>{categoryLabel(ticket.category)}</dd>
              {ticket.endpoint && (
                <>
                  <dt className="text-muted-foreground">Endpoint</dt>
                  <dd className="ph-no-capture truncate font-mono text-xs leading-5">
                    {ticket.endpoint.name ?? ticket.endpoint.slug}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Opened</dt>
              <dd>{shortDateTime(ticket.createdAt)}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}
