"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, ApiError, shortDateTime } from "@/lib/support/client";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";

interface Session {
  id: string;
  ticketNumber: number;
  expiresAt: string;
  account: { email: string; name: string | null; homeSite: string };
}

interface Endpoint {
  id: string;
  slug: string;
  name: string | null;
  site: string;
  requestCount: number;
}

interface RequestRow {
  id: string;
  method: string;
  path: string;
  kind: "http" | "email";
  receivedAt: string;
  size: number;
  email: { subject: string | null; from: string | null } | null;
}

interface RequestDetail {
  id: string;
  method: string;
  path: string;
  kind: "http" | "email";
  receivedAt: string;
  query: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  signature: { verified: boolean; error: string | null } | null;
  email: {
    subject: string | null;
    from: string[];
    to: string[];
    text: string | null;
    attachments: { filename: string | null; contentType: string | null; size: number | null }[];
  } | null;
}

function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

/**
 * The read-only view of an account, under the ochre band. It reads through
 * the view routes only, which check on every call that the session is live
 * and the user's grant still holds, and log each endpoint and request opened
 * for the user to see. There is nothing here that writes.
 */
export function ViewAs({ sessionId }: { sessionId: string }) {
  const { token } = useOps();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const handle = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 410 || error.code === "view_ended")) {
      setEnded(error.message);
    } else {
      setEnded(error instanceof Error ? error.message : "The view could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void apiFetch<{ session: Session; endpoints: Endpoint[] }>(
      token,
      `/api/ops/view-sessions/${sessionId}`
    )
      .then((data) => {
        setSession(data.session);
        setEndpoints(data.endpoints);
        setEndpointId(data.endpoints[0]?.id ?? null);
      })
      .catch(handle);
  }, [token, sessionId, handle]);

  useEffect(() => {
    if (!endpointId || ended) return;
    setRequests(null);
    setDetail(null);
    void apiFetch<RequestRow[]>(
      token,
      `/api/ops/view-sessions/${sessionId}/endpoints/${endpointId}`
    )
      .then(setRequests)
      .catch(handle);
  }, [token, sessionId, endpointId, ended, handle]);

  // The band's countdown, and the end of the view when it runs out.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        setEnded("This view ran out after 30 minutes. Open a new one from the ticket.");
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [session]);

  const openRequest = async (id: string) => {
    try {
      setDetail(
        await apiFetch<RequestDetail>(token, `/api/ops/view-sessions/${sessionId}/requests/${id}`)
      );
    } catch (error) {
      handle(error);
    }
  };

  const exit = async () => {
    try {
      await apiFetch(token, `/api/ops/view-sessions/${sessionId}`, { method: "DELETE" });
    } catch {
      // Ending is best effort; the session runs out on its own.
    }
    router.push(session ? `/ops/tickets/${session.ticketNumber}` : "/ops/tickets");
  };

  const name = session?.account.name?.trim() || session?.account.email || "this account";

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-staff-line bg-staff-wash px-5 py-2.5 text-sm text-staff"
      >
        <span className="ph-no-capture">
          {session ? (
            <>
              You are viewing <b>{name}</b>&rsquo;s account as support. Read-only, for ticket{" "}
              <span className="font-mono">#{session.ticketNumber}</span>.{" "}
              {ended
                ? "This view has ended."
                : `This view ends in ${minutesLeft(session.expiresAt)} minutes.`}
            </>
          ) : (
            "Opening a read-only view..."
          )}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-8 border-staff-line bg-background text-staff hover:bg-background/80"
          onClick={() => void exit()}
        >
          Back to the ticket
        </Button>
      </div>

      {ended ? (
        <div className="mx-auto max-w-md space-y-3 p-10 text-center">
          <p className="text-sm">{ended}</p>
          {session && (
            <Button
              variant="outline"
              render={<Link href={`/ops/tickets/${session.ticketNumber}`} />}
            >
              Back to the ticket
            </Button>
          )}
        </div>
      ) : !session ? (
        <div className="p-6">
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      ) : (
        <div className="grid flex-1 lg:grid-cols-[14rem_minmax(0,22rem)_minmax(0,1fr)]">
          <nav
            aria-label="Endpoints"
            className="border-b border-border bg-card p-2 lg:border-b-0 lg:border-r"
          >
            {endpoints.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No endpoints.</p>
            ) : (
              <ul className="ph-no-capture space-y-0.5">
                {endpoints.map((endpoint) => (
                  <li key={endpoint.id}>
                    <button
                      type="button"
                      onClick={() => setEndpointId(endpoint.id)}
                      className={cn(
                        "w-full truncate rounded-md px-3 py-1.5 text-left text-sm",
                        endpoint.id === endpointId
                          ? "bg-selected font-medium text-selected-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      )}
                    >
                      {endpoint.name || endpoint.slug}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>

          <section
            aria-label="Requests"
            className="border-b border-border lg:border-b-0 lg:border-r"
          >
            {requests === null ? (
              <div className="p-4">
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            ) : requests.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nothing captured.</p>
            ) : (
              <ul className="ph-no-capture">
                {requests.map((row) => (
                  <li key={row.id} className="border-t border-border first:border-t-0">
                    <button
                      type="button"
                      onClick={() => void openRequest(row.id)}
                      className={cn(
                        "grid w-full grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60",
                        detail?.id === row.id && "bg-muted"
                      )}
                    >
                      <span
                        className={cn(
                          "font-mono text-xs font-medium",
                          row.kind === "email" ? "text-kind-email" : "text-method-post"
                        )}
                      >
                        {row.kind === "email" ? "EMAIL" : row.method}
                      </span>
                      <span className="truncate">{row.email?.subject ?? row.path}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {new Date(row.receivedAt).toISOString().slice(11, 16)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Request" className="min-w-0 p-5">
            {!detail ? (
              <p className="text-sm text-muted-foreground">
                Pick a request. Each one you open is listed in {name}&rsquo;s access log.
              </p>
            ) : (
              <div className="ph-no-capture space-y-4 text-sm">
                <p className="text-xs text-muted-foreground">
                  {detail.kind === "email" ? "Email" : `${detail.method} ${detail.path}`}, received{" "}
                  {shortDateTime(detail.receivedAt)}
                  {detail.signature &&
                    `, signature ${detail.signature.verified ? "verified" : `failed${detail.signature.error ? ` (${detail.signature.error})` : ""}`}`}
                </p>
                {detail.email && (
                  <div className="space-y-2">
                    <h2 className="text-base font-semibold">
                      {detail.email.subject ?? "(no subject)"}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      From {detail.email.from.join(", ") || "unknown"} to{" "}
                      {detail.email.to.join(", ")}
                    </p>
                    <pre className="ui-code max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-mono text-xs">
                      {detail.email.text ?? "(no text part)"}
                    </pre>
                    {detail.email.attachments.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Attachments:{" "}
                        {detail.email.attachments
                          .map(
                            (attachment) => attachment.filename ?? attachment.contentType ?? "file"
                          )
                          .join(", ")}
                      </p>
                    )}
                  </div>
                )}
                {detail.headers && (
                  <details open={detail.kind === "http"}>
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      Headers
                    </summary>
                    <pre className="ui-code mt-2 max-h-64 overflow-auto rounded-md border border-border p-3 font-mono text-xs">
                      {Object.entries(detail.headers)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join("\n")}
                    </pre>
                  </details>
                )}
                {detail.query && <p className="font-mono text-xs">?{detail.query}</p>}
                {detail.body !== null && (
                  <pre className="ui-code max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-mono text-xs">
                    {detail.body || "(empty body)"}
                  </pre>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
