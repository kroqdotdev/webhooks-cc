"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Conversation, ImagePicker, supportBody, TurnLine } from "@/components/support/thread";
import { apiFetch, shortDateTime, waitLabel } from "@/lib/support/client";
import { BODY_MAX, type SupportTicketDetail } from "@/lib/support/shared";
import type { QueueItem, QueueView } from "@/lib/ops/tickets";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";

const VIEWS: { value: QueueView; label: string }[] = [
  { value: "waiting", label: "Waiting on you" },
  { value: "user", label: "Waiting on user" },
  { value: "snoozed", label: "Snoozed" },
  { value: "closed", label: "Closed" },
  { value: "spam", label: "Spam" },
];

interface StaffTicket {
  ticket: SupportTicketDetail & {
    snoozedUntil: string | null;
    spam: boolean;
    context: Record<string, unknown>;
    ratingComment: string | null;
    categoryLabel: string;
  };
  account: {
    id: string;
    email: string;
    name: string | null;
    plan: string;
    interval: string | null;
    createdAt: string;
    requestLimit: number;
    requestsUsed: number;
    homeSite: string;
    earlierTickets: number;
  } | null;
}

interface SavedReply {
  id: string;
  title: string;
  body: string;
}

function planLabel(plan: string, interval?: string | null): string {
  const name = plan.charAt(0).toUpperCase() + plan.slice(1);
  return interval ? `${name}, ${interval === "year" ? "annual" : "monthly"}` : name;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT" ||
      element.isContentEditable)
  );
}

/** Fills {{name}} and {{plan}} in a saved reply. */
function fillReply(body: string, account: StaffTicket["account"]): string {
  const name = account?.name?.trim().split(/\s+/)[0] ?? "there";
  return body
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*plan\s*\}\}/g, account ? planLabel(account.plan) : "your plan");
}

export function OpsInbox({ number }: { number: string | null }) {
  const { token } = useOps();
  const router = useRouter();
  const [view, setView] = useState<QueueView>("waiting");
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [selected, setSelected] = useState<StaffTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadQueue = useCallback(async () => {
    try {
      const data = await apiFetch<{ tickets: QueueItem[] }>(token, `/api/ops/tickets?view=${view}`);
      setQueue(data.tickets);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Tickets could not be loaded.");
    }
  }, [token, view]);

  const loadTicket = useCallback(async () => {
    if (!number || !/^\d{1,12}$/.test(number)) {
      setSelected(null);
      return;
    }
    try {
      setSelected(await apiFetch<StaffTicket>(token, `/api/ops/tickets/${number}`));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The ticket could not be loaded.");
    }
  }, [token, number]);

  useEffect(() => {
    void loadQueue();
    const timer = setInterval(() => {
      setNow(Date.now());
      void loadQueue();
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadQueue]);

  useEffect(() => {
    void loadTicket();
  }, [loadTicket]);

  // A ticket opened from a link that is not in this view picks its view.
  useEffect(() => {
    if (!selected || !queue) return;
    if (queue.some((item) => item.number === selected.ticket.number)) return;
    const t = selected.ticket;
    const fitting: QueueView = t.spam
      ? "spam"
      : t.status === "closed"
        ? "closed"
        : t.snoozedUntil && new Date(t.snoozedUntil) > new Date()
          ? "snoozed"
          : t.waitingOn === "user"
            ? "user"
            : "waiting";
    if (fitting !== view) setView(fitting);
    // Only when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ticket.number]);

  const go = useCallback(
    (offset: number) => {
      if (!queue || queue.length === 0) return;
      const index = queue.findIndex((item) => String(item.number) === number);
      const next = queue[Math.min(queue.length - 1, Math.max(0, index + offset))];
      if (next) router.push(`/ops/tickets/${next.number}`);
    },
    [queue, number, router]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") go(1);
      if (event.key === "k") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <div className="lg:grid lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[17rem_minmax(0,1fr)]">
      <section
        aria-label="Tickets"
        className="border-b border-border bg-card lg:border-b-0 lg:border-r"
      >
        <div className="flex flex-wrap gap-1 border-b border-border p-2">
          {VIEWS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => {
                setQueue(null);
                setView(entry.value);
              }}
              aria-pressed={view === entry.value}
              className={cn(
                "rounded-md px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === entry.value
                  ? "bg-selected font-medium text-selected-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {queue === null ? (
          <div className="space-y-2 p-3" role="status" aria-label="Loading tickets">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : queue.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {view === "waiting" ? "No one is waiting on you." : "No tickets here."}
          </p>
        ) : (
          <ul className="ph-no-capture">
            {queue.map((item) => {
              const active = String(item.number) === number;
              const hours = (now - new Date(item.waitingSince).getTime()) / 3_600_000;
              const late = view === "waiting" && hours >= 24;
              return (
                <li key={item.id} className="border-t border-border first:border-t-0">
                  <Link
                    href={`/ops/tickets/${item.number}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block px-3 py-2.5 text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active && "bg-background shadow-[inset_2px_0_0_hsl(var(--primary))]"
                    )}
                  >
                    <span className="block truncate font-medium">{item.subject}</span>
                    <span className="mt-0.5 flex justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {item.categoryLabel}, {planLabel(item.user.plan)}
                        {item.blocking && <span className="text-destructive-ink">, blocking</span>}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {view === "closed"
                          ? shortDateTime(item.lastMessageAt)
                          : waitLabel(item.waitingSince, now)}
                      </span>
                    </span>
                    {view === "waiting" && (
                      <span className="mt-1.5 block h-0.5 overflow-hidden rounded-full bg-border">
                        <span
                          className={cn(
                            "block h-full",
                            late ? "bg-destructive" : "bg-muted-foreground"
                          )}
                          style={{ width: `${Math.min(100, (hours / 24) * 100)}%` }}
                        />
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="min-w-0">
        {error && <p className="px-6 pt-4 text-sm text-destructive-ink">{error}</p>}
        {!number ? (
          <div className="hidden p-8 text-sm text-muted-foreground lg:block">
            Pick a ticket. <kbd className="font-mono">j</kbd> and <kbd className="font-mono">k</kbd>{" "}
            move through the list.
          </div>
        ) : !selected ? (
          <div className="space-y-3 p-6" role="status" aria-label="Loading the ticket">
            <Skeleton className="h-6 w-2/3 rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <TicketPane
            key={selected.ticket.number}
            data={selected}
            token={token}
            onChange={(fresh) => {
              setSelected(fresh);
              void loadQueue();
            }}
          />
        )}
      </div>
    </div>
  );
}

function TicketPane({
  data,
  token,
  onChange,
}: {
  data: StaffTicket;
  token: string | null;
  onChange: (fresh: StaffTicket) => void;
}) {
  const { ticket, account } = data;
  const router = useRouter();
  const [mode, setMode] = useState<"message" | "note">("message");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedReply[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const userName = account?.name?.trim() || account?.email || "The user";

  useEffect(() => {
    if (!pickerOpen || saved) return;
    void apiFetch<SavedReply[]>(token, "/api/ops/saved-replies")
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [pickerOpen, saved, token]);

  const patch = async (json: Record<string, unknown>) => {
    try {
      onChange(
        await apiFetch<StaffTicket>(token, `/api/ops/tickets/${ticket.number}`, {
          method: "PATCH",
          json,
        })
      );
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "The change could not be saved.");
    }
  };

  const send = async (close: boolean) => {
    if (!body.trim() && !close && images.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const { body: payload, json } = supportBody({ body, kind: mode, close }, images);
      const response = await fetch(`/api/ops/tickets/${ticket.number}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body: payload,
      });
      const fresh = (await response.json().catch(() => null)) as
        StaffTicket | { error?: string } | null;
      if (!response.ok || !fresh || !("ticket" in fresh)) {
        throw new Error(
          (fresh as { error?: string } | null)?.error ?? "The reply could not be sent."
        );
      }
      setBody("");
      setImages([]);
      onChange(fresh);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The reply could not be sent.");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "r") {
        event.preventDefault();
        setMode("message");
        textRef.current?.focus();
      } else if (event.key === "n") {
        event.preventDefault();
        setMode("note");
        textRef.current?.focus();
      } else if (event.key === "e" && ticket.status === "open") {
        event.preventDefault();
        void patch({ close: true });
      } else if (event.key === "/") {
        event.preventDefault();
        setPickerOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openView = async () => {
    setViewing(true);
    try {
      const session = await apiFetch<{ id: string }>(token, "/api/ops/view-sessions", {
        method: "POST",
        json: { ticketNumber: ticket.number },
      });
      router.push(`/ops/view/${session.id}`);
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : "The view could not be opened.");
      setViewing(false);
    }
  };

  const snoozeOptions = useMemo(
    () => [
      { label: "Tomorrow", until: () => new Date(Date.now() + 24 * 3_600_000) },
      { label: "3 days", until: () => new Date(Date.now() + 3 * 24 * 3_600_000) },
      { label: "A week", until: () => new Date(Date.now() + 7 * 24 * 3_600_000) },
    ],
    []
  );
  const snoozed = ticket.snoozedUntil && new Date(ticket.snoozedUntil) > new Date();
  const context = ticket.context as { from?: string; appVersion?: string; userAgent?: string };

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-5 p-6">
        <div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">#{ticket.number}</span>, opened on{" "}
            {ticket.site === "mailhooks" ? "mailhooks.cc" : "webhooks.cc"}, {ticket.categoryLabel}
            {ticket.blocking && <span className="text-destructive-ink">, blocking</span>}
          </p>
          <h1 className="ph-no-capture mt-1 text-xl font-semibold">{ticket.subject}</h1>
        </div>
        <TurnLine
          waitingOn={ticket.waitingOn}
          closed={ticket.status === "closed"}
          left={account?.name?.trim().split(/\s+/)[0] || "User"}
          right="Support"
        />
        <Conversation
          messages={ticket.messages}
          audience="staff"
          token={token}
          userName={userName}
        />

        {ticket.rating !== null && (
          <p className="text-sm text-muted-foreground">
            Rated {ticket.rating} of 5{ticket.ratingComment ? `: "${ticket.ratingComment}"` : "."}
          </p>
        )}

        <div
          className={cn(
            "ui-card ui-card-static space-y-3 p-3!",
            mode === "note" && "border-staff-line bg-staff-wash"
          )}
        >
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => setMode("message")}
              aria-pressed={mode === "message"}
              className={cn(
                "rounded-md px-2 py-1",
                mode === "message"
                  ? "bg-selected font-medium text-selected-foreground"
                  : "text-muted-foreground"
              )}
            >
              Reply
            </button>
            <button
              type="button"
              onClick={() => setMode("note")}
              aria-pressed={mode === "note"}
              className={cn(
                "rounded-md px-2 py-1 text-staff",
                mode === "note" && "bg-background font-medium"
              )}
            >
              Note
            </button>
            <span className="flex-1" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((open) => !open)}
                className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
              >
                Saved replies <kbd className="font-mono">/</kbd>
              </button>
              {pickerOpen && (
                <div className="absolute right-0 z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                  {saved === null ? (
                    <p className="p-2 text-xs text-muted-foreground">Loading...</p>
                  ) : saved.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      None yet.{" "}
                      <Link href="/ops/saved-replies" className="underline">
                        Add one
                      </Link>
                      .
                    </p>
                  ) : (
                    saved.map((reply) => (
                      <button
                        key={reply.id}
                        type="button"
                        className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setBody(
                            (current) =>
                              (current ? `${current}\n\n` : "") + fillReply(reply.body, account)
                          );
                          setPickerOpen(false);
                          textRef.current?.focus();
                        }}
                      >
                        {reply.title}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <label htmlFor="staff-reply" className="sr-only">
            {mode === "note" ? "Note" : "Reply"}
          </label>
          <Textarea
            id="staff-reply"
            ref={textRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={BODY_MAX}
            placeholder={mode === "note" ? "A note only staff see" : `Write to ${userName}`}
            className="ph-no-capture border-0 bg-transparent px-1 focus-visible:ring-0 focus-visible:ring-offset-0"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send(event.shiftKey && mode === "message");
              }
              if (event.key === "Escape") textRef.current?.blur();
            }}
          />
          {mode === "message" && (
            <ImagePicker files={images} onChange={setImages} disabled={sending} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              {mode === "note"
                ? "Only staff see notes."
                : ticket.notifyEmail
                  ? `${userName} gets this by email.`
                  : `${userName} turned off email for this ticket.`}
            </span>
            <div className="flex gap-2">
              {mode === "message" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  onClick={() => void send(true)}
                  title="Ctrl or Cmd + Shift + Enter"
                >
                  {body.trim() ? "Send and close" : "Close"}
                </Button>
              )}
              <Button
                size="sm"
                disabled={sending || (!body.trim() && images.length === 0)}
                onClick={() => void send(false)}
                title="Ctrl or Cmd + Enter"
              >
                {mode === "note" ? "Add note" : "Send"}
              </Button>
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          <kbd className="font-mono">r</kbd> reply, <kbd className="font-mono">n</kbd> note,{" "}
          <kbd className="font-mono">e</kbd> close, <kbd className="font-mono">/</kbd> saved
          replies, <kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd> move
        </p>
      </div>

      <aside className="space-y-4 border-t border-border bg-card p-5 text-sm xl:border-l xl:border-t-0">
        {account ? (
          <div className="ph-no-capture space-y-1">
            <h2 className="font-semibold">{account.name?.trim() || account.email}</h2>
            <p className="break-all text-xs text-muted-foreground">{account.email}</p>
          </div>
        ) : (
          <p className="text-muted-foreground">The account is gone.</p>
        )}
        {account && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{planLabel(account.plan, account.interval)}</dd>
            <dt className="text-muted-foreground">Joined</dt>
            <dd>{shortDateTime(account.createdAt).split(",")[0]}</dd>
            <dt className="text-muted-foreground">Quota</dt>
            <dd className="tabular-nums">
              {account.requestLimit > 0
                ? `${Math.round((account.requestsUsed / account.requestLimit) * 100)}% used`
                : "–"}
            </dd>
            <dt className="text-muted-foreground">Tickets</dt>
            <dd>{account.earlierTickets} earlier</dd>
          </dl>
        )}

        <div
          className={cn(
            "rounded-md border p-3 text-xs",
            ticket.accessActive ? "border-primary/30 bg-selected/50" : "border-dashed border-input"
          )}
        >
          {ticket.accessActive ? (
            <>
              <b className="text-selected-foreground">Access given</b> on this ticket
              {ticket.status === "closed" && ticket.accessEndsAt
                ? `, until ${shortDateTime(ticket.accessEndsAt)}.`
                : ", until 7 days after it closes."}
            </>
          ) : (
            <>No access to contents. Ask on the ticket; it offers the user a button to give it.</>
          )}
        </div>
        <div className="grid gap-2">
          <Button
            size="sm"
            disabled={!ticket.accessActive || viewing}
            onClick={() => void openView()}
          >
            View as {account?.name?.trim().split(/\s+/)[0] || "user"}
          </Button>
          {account && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/ops/accounts/${account.id}`}>Open account</Link>
            </Button>
          )}
        </div>

        {ticket.endpoint && (
          <p className="text-xs">
            <span className="text-muted-foreground">Endpoint </span>
            <span className="ph-no-capture font-mono">{ticket.endpoint.slug}</span>
          </p>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs font-medium text-muted-foreground">
            {snoozed ? `Snoozed until ${shortDateTime(ticket.snoozedUntil!)}` : "Snooze"}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {snoozed ? (
              <Button size="sm" variant="outline" onClick={() => void patch({ snoozeUntil: null })}>
                Wake now
              </Button>
            ) : (
              snoozeOptions.map((option) => (
                <Button
                  key={option.label}
                  size="sm"
                  variant="outline"
                  disabled={ticket.status === "closed"}
                  onClick={() => void patch({ snoozeUntil: option.until().toISOString() })}
                >
                  {option.label}
                </Button>
              ))
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="px-0 text-muted-foreground"
            onClick={() => void patch({ spam: !ticket.spam })}
          >
            {ticket.spam ? "Not spam" : "Mark as spam"}
          </Button>
        </div>

        {(context.from || context.appVersion || context.userAgent) && (
          <dl className="space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
            {context.from && (
              <div>
                <dt className="inline">Sent from </dt>
                <dd className="inline font-mono">{context.from}</dd>
              </div>
            )}
            {context.appVersion && (
              <div>
                <dt className="inline">App </dt>
                <dd className="inline">{context.appVersion}</dd>
              </div>
            )}
            {context.userAgent && <dd className="break-words">{context.userAgent}</dd>}
          </dl>
        )}
      </aside>
    </div>
  );
}
