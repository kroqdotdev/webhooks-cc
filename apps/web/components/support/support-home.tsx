"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Mail } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { MfaGate } from "@/components/auth/mfa-challenge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, shortDay, timeAgo } from "@/lib/support/client";
import type { SupportTicketSummary } from "@/lib/support/shared";
import { subscribeToSupportTickets } from "@/lib/supabase/realtime";
import { cn } from "@/lib/utils";

/**
 * /support: signed in, the person's tickets; signed out, how to reach us
 * and a way to sign in to open a ticket. The page itself stays public and
 * indexable; tickets are fetched in the browser.
 */
export function SupportHome() {
  const { isAuthenticated, isLoading, session } = useAuth();

  return (
    <main className="mx-auto max-w-3xl px-6 pb-16 pt-10 md:px-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold clean:font-semibold md:text-4xl">Support</h1>
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            {isAuthenticated
              ? "Ask about anything in your account. You get an answer here, and by email if you want one."
              : "Questions about webhooks.cc or mailhooks.cc, billing, or your account. Signed in, you can open a ticket and follow it here."}
          </p>
        </div>
        {isAuthenticated && (
          <Button asChild>
            <Link href="/support/new">New ticket</Link>
          </Button>
        )}
      </div>

      {isLoading ? (
        <ListSkeleton />
      ) : isAuthenticated ? (
        <MfaGate>
          <TicketList token={session?.access_token ?? null} userId={session?.user.id ?? null} />
        </MfaGate>
      ) : (
        <SignedOut />
      )}
    </main>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading tickets" className="ui-card ui-card-static space-y-3">
      <Skeleton className="h-4 w-2/3 rounded-md" />
      <Skeleton className="h-4 w-1/3 rounded-md" />
    </div>
  );
}

function TicketRows({ tickets }: { tickets: SupportTicketSummary[] }) {
  return (
    <ul className="ui-card ui-card-static p-0! overflow-hidden ph-no-capture">
      {tickets.map((ticket) => {
        const closed = ticket.status === "closed";
        const yours = !closed && ticket.waitingOn === "user";
        return (
          <li key={ticket.id} className="border-t border-line first:border-t-0">
            <Link
              href={`/support/${ticket.number}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3.5 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span
                className={cn("truncate text-sm", closed ? "text-muted-foreground" : "font-medium")}
              >
                {ticket.subject}
              </span>
              <span
                className={cn(
                  "row-span-2 text-right text-xs",
                  yours ? "font-semibold text-primary-ink" : "text-muted-foreground"
                )}
              >
                {yours && (
                  <span
                    className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                    aria-hidden="true"
                  />
                )}
                {closed && ticket.closedAt
                  ? `Closed ${shortDay(ticket.closedAt)}`
                  : yours
                    ? "Your turn"
                    : "With support"}
              </span>
              <span className="text-xs text-muted-foreground">
                <span className="font-mono">#{ticket.number}</span>,{" "}
                {closed
                  ? `${ticket.messageCount} message${ticket.messageCount === 1 ? "" : "s"}`
                  : yours
                    ? `support replied ${timeAgo(ticket.waitingSince)}`
                    : `you wrote ${timeAgo(ticket.lastMessageAt)}`}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function TicketList({ token, userId }: { token: string | null; userId: string | null }) {
  const [tickets, setTickets] = useState<SupportTicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ tickets: SupportTicketSummary[] }>(
        token,
        "/api/support/tickets"
      );
      setTickets(data.tickets);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Your tickets could not be loaded."
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    return subscribeToSupportTickets(userId, () => void load());
  }, [userId, load]);

  if (tickets === null) {
    return error ? (
      <div className="ui-card ui-card-static flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <ListSkeleton />
    );
  }

  const open = tickets.filter((ticket) => ticket.status === "open");
  const closed = tickets.filter((ticket) => ticket.status === "closed");

  if (tickets.length === 0) {
    return (
      <div className="ui-card ui-card-static space-y-3">
        <p className="text-sm font-medium">No tickets yet.</p>
        <p className="text-sm text-muted-foreground">
          When something does not work as you expect, open a ticket and describe what happened. Most
          answers arrive within a working day.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/support/new">New ticket</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/docs">Read the docs</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {open.length > 0 && <TicketRows tickets={open} />}
      {closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">Closed</h2>
          <TicketRows tickets={closed} />
        </section>
      )}
    </div>
  );
}

function SignedOut() {
  return (
    <div className="space-y-8">
      <div className="ui-card ui-card-static space-y-3">
        <h2 className="text-lg font-bold clean:font-semibold">Open a ticket</h2>
        <p className="text-sm text-muted-foreground">
          Sign in to open a ticket about your account. You can follow the answer here, get it by
          email, and let support look at your account while the ticket is open.
        </p>
        <Button asChild>
          <Link href="/login?redirect=/support/new">Sign in to open a ticket</Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <a
          href="mailto:support@webhooks.cc"
          className="ui-card flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Mail className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>
            <span className="block font-semibold">Email support</span>
            <span className="text-sm text-muted-foreground">
              No account, or cannot sign in? Write to support@webhooks.cc.
            </span>
          </span>
        </a>
        <Link
          href="/docs"
          className="ui-card flex items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookOpen className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>
            <span className="block font-semibold">Read the docs</span>
            <span className="text-sm text-muted-foreground">
              Setup, endpoints, email capture, the CLI and the SDKs.
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}
