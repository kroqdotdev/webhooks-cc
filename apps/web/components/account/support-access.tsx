"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Panel } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, shortDateTime } from "@/lib/support/client";

interface Grant {
  number: number;
  subject: string;
  status: "open" | "closed";
  grantedAt: string | null;
  endsAt: string | null;
}

interface LogEntry {
  id: number;
  action: "view_started" | "view_endpoint" | "view_request" | "view_ended";
  ticketNumber: number | null;
  targetId: string | null;
  at: string;
}

function describe(entry: LogEntry): string {
  switch (entry.action) {
    case "view_started":
      return "Support opened a read-only view of your account";
    case "view_endpoint":
      return `Support looked at the requests of endpoint ${entry.targetId ?? ""}`.trim();
    case "view_request":
      return "Support opened one captured request";
    case "view_ended":
      return "Support closed the view";
  }
}

/**
 * Who may look at the account and who did: the tickets that give support
 * access, and every view staff opened, endpoint and request by request.
 */
export function SupportAccess({ token }: { token: string | null }) {
  const [data, setData] = useState<{ grants: Grant[]; log: LogEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch(token, "/api/support/access-log"));
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Support access could not be loaded."
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const withdraw = async (number: number) => {
    try {
      await apiFetch(token, `/api/support/tickets/${number}`, {
        method: "PATCH",
        json: { accessGranted: false },
      });
      await load();
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : "Access is still given.");
    }
  };

  if (!data) {
    return (
      <Panel>
        {error ? (
          <p className="text-sm text-destructive-ink">{error}</p>
        ) : (
          <div role="status" aria-label="Loading" className="space-y-2">
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </div>
        )}
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <Panel
        id="grants"
        title="Access you gave"
        description="While a ticket gives access, support can read your endpoints and captured requests and emails, read-only. Access ends 7 days after the ticket closes."
        flush
      >
        {data.grants.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            Support cannot view your account. You can give access on a ticket when it helps.
          </p>
        ) : (
          <ul>
            {data.grants.map((grant) => (
              <li
                key={grant.number}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0 text-sm">
                  <Link
                    href={`/support/${grant.number}`}
                    className="ph-no-capture font-medium hover:underline"
                  >
                    <span className="font-mono">#{grant.number}</span> {grant.subject}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {grant.status === "open"
                      ? "Until 7 days after the ticket closes"
                      : grant.endsAt
                        ? `Until ${shortDateTime(grant.endsAt)}`
                        : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void withdraw(grant.number)}>
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="access-log" title="When support looked" flush>
        {data.log.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            Support has never viewed your account.
          </p>
        ) : (
          <ul className="ph-no-capture">
            {data.log.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line/60 px-5 py-2.5 text-sm last:border-b-0"
              >
                <span>
                  {describe(entry)}
                  {entry.ticketNumber !== null && (
                    <span className="text-muted-foreground">
                      {" "}
                      for{" "}
                      <Link
                        href={`/support/${entry.ticketNumber}`}
                        className="font-mono hover:underline"
                      >
                        #{entry.ticketNumber}
                      </Link>
                    </span>
                  )}
                </span>
                <time dateTime={entry.at} className="text-xs text-muted-foreground">
                  {shortDateTime(entry.at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
