"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  ForwardingOffError,
  fetchDeliveryLog,
  redeliverAllFailed,
  type DashboardEndpoint,
  type DeliveryLogFilter,
  type LogDelivery,
} from "@/lib/dashboard-api";
import { formatDuration } from "@/lib/forwarding/timing";
import {
  describeAnswer,
  formatCappedCount,
  formatClock,
  formatCount,
  formatIn,
  formatSenderLag,
  formatTries,
  senderTimeFromRecord,
} from "@/lib/forwarding/display";
import { getMethodColor } from "@/types/request";
import { DeliveryChip, chipStatus } from "./delivery-pane";
import { Section, Segmented } from "./settings-primitives";
import { useDeliverySummary, useDocumentVisible, useOnScreen } from "./use-delivery-summary";

const PAGE_SIZE = 50;

/** Newer rows first, then the rows already loaded, each id once. */
function mergeRows(fresh: LogDelivery[], existing: LogDelivery[]): LogDelivery[] {
  const byId = new Map(fresh.map((row) => [row.id, row]));
  const merged = [...fresh];
  for (const row of existing) if (!byId.has(row.id)) merged.push(row);
  return merged;
}

function DeliveredAfter({ row, now }: { row: LogDelivery; now: number }) {
  if (row.status === "succeeded") {
    const received = row.receivedAt ?? row.createdAt;
    return <>{row.finishedAt !== null ? formatDuration(row.finishedAt - received) : ""}</>;
  }
  if (row.status === "failed") {
    return <span className="text-muted-foreground">after {formatTries(row.attempts)}</span>;
  }
  if (row.attempts === 0) return <span className="text-muted-foreground">queued</span>;
  return (
    <span className="text-muted-foreground">
      {row.nextAttemptAt !== null ? `next ${formatIn(row.nextAttemptAt, now)}` : "retrying"}
    </span>
  );
}

/**
 * The endpoint's delivery log: every forwarded request, newest first, with
 * a filter for those retrying or failed, older pages on request, and a way
 * to queue every failed delivery again. Updates while it is on screen.
 */
export function DeliveriesSection({
  endpoint,
  onOpenRequest,
}: {
  endpoint: DashboardEndpoint;
  /** Opens the request with its Deliveries tab active. */
  onOpenRequest: (requestId: string) => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const sectionRef = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(sectionRef);
  const documentVisible = useDocumentVisible();
  const active = onScreen && documentVisible;
  const { summary, refresh: refreshSummary } = useDeliverySummary(
    endpoint.slug,
    endpoint.id,
    active
  );

  const [filter, setFilter] = useState<DeliveryLogFilter>("all");
  const [rows, setRows] = useState<LogDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Whether older pages were loaded: a ref for the pollers, state for the footer.
  const loadedOlder = useRef(false);
  const [olderLoaded, setOlderLoaded] = useState(false);

  const loadNewest = useCallback(async () => {
    if (!accessToken) return;
    try {
      const fresh = await fetchDeliveryLog(accessToken, endpoint.slug, {
        limit: PAGE_SIZE,
        status: filter,
      });
      setRows((prev) => (prev && loadedOlder.current ? mergeRows(fresh, prev) : fresh));
      if (fresh.length < PAGE_SIZE && !loadedOlder.current) setExhausted(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deliveries could not be loaded.");
    }
    setNow(Date.now());
  }, [accessToken, endpoint.slug, filter]);

  // A new filter starts over.
  useEffect(() => {
    setRows(null);
    setExhausted(false);
    loadedOlder.current = false;
    setOlderLoaded(false);
    void loadNewest();
  }, [loadNewest]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void loadNewest(), 5000);
    return () => clearInterval(timer);
  }, [active, loadNewest]);

  const loadOlder = async () => {
    if (!accessToken || !rows || rows.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await fetchDeliveryLog(accessToken, endpoint.slug, {
        limit: PAGE_SIZE,
        status: filter,
        before: rows[rows.length - 1].cursor,
      });
      loadedOlder.current = true;
      setOlderLoaded(true);
      setRows((prev) => (prev ? mergeRows(prev, older) : older));
      if (older.length < PAGE_SIZE) setExhausted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Older deliveries could not be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  };

  // Redeliver all failed: a small inline confirmation, then the count queued.
  const [confirming, setConfirming] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const failedCount = summary?.failed ?? 0;
  const redeliverFailed = async () => {
    if (!accessToken || queuing) return;
    setQueuing(true);
    try {
      const { queued } = await redeliverAllFailed(accessToken, endpoint.slug);
      setResult({
        text:
          queued === 0
            ? "Nothing queued: each of these was already sent again."
            : queued < failedCount
              ? `Queued ${formatCount(queued)}. The rest can be sent once these are through.`
              : `Queued ${formatCount(queued)}. They go out oldest first.`,
        error: false,
      });
      setConfirming(false);
      await Promise.all([loadNewest(), refreshSummary()]);
    } catch (err) {
      setResult({
        text:
          err instanceof ForwardingOffError
            ? "Turn forwarding on first."
            : "The failed deliveries could not be queued again.",
        error: true,
      });
    } finally {
      setQueuing(false);
    }
  };
  useEffect(() => {
    setConfirming(false);
    setResult(null);
  }, [filter]);

  const showSentColumn = useMemo(() => rows?.some((row) => row.senderAt !== null) ?? false, [rows]);
  const total =
    filter === "all" ? summary?.total : filter === "pending" ? summary?.pending : summary?.failed;
  const forwardingOn = endpoint.forwardEnabled === true;

  const empty = (() => {
    if (filter === "pending") return "Nothing is retrying.";
    if (filter === "failed") return "Nothing has failed among the kept deliveries.";
    if (!forwardingOn) {
      return "Forwarding is off. Deliveries from before stay here as long as their requests.";
    }
    return "No deliveries yet. The next request this endpoint captures shows up here within a second or two.";
  })();

  const open = (row: LogDelivery) => onOpenRequest(row.requestId);
  const cell = "py-2 pr-2.5 border-b border-line/15 align-middle";
  const num = cn(cell, "font-mono text-xs whitespace-nowrap");

  return (
    <Section
      id="deliveries"
      sectionRef={sectionRef}
      title="Deliveries"
      description="Every request forwarded from this endpoint, newest first. Kept as long as the request itself. Open one for every try and to redeliver."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          name="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            {
              value: "pending",
              label: "Retrying",
              count: formatCappedCount(summary?.pending ?? 0),
            },
            { value: "failed", label: "Failed", count: formatCappedCount(summary?.failed ?? 0) },
          ]}
        />
        <span className="text-xs text-muted-foreground">Updates as deliveries happen.</span>
      </div>

      {filter === "failed" && failedCount > 0 && forwardingOn && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          {confirming ? (
            <>
              <span>
                Send the {formatCappedCount(failedCount)} failed{" "}
                {failedCount === 1 ? "delivery" : "deliveries"} again with the current URL, format
                and headers?
              </span>
              <button
                type="button"
                onClick={() => void redeliverFailed()}
                disabled={queuing}
                className={cn(
                  "ui-btn-primary py-1! px-2.5! text-xs",
                  queuing && "opacity-50 cursor-not-allowed"
                )}
              >
                {queuing ? "Queuing..." : "Send them again"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="ui-btn-outline py-1! px-2.5! text-xs"
              >
                Keep them
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setConfirming(true);
              }}
              className="ui-btn-outline py-1.5! px-3! text-xs"
            >
              Redeliver all failed
            </button>
          )}
        </div>
      )}
      {result && (
        <p
          role="status"
          aria-live="polite"
          className={cn("text-[13px]", result.error ? "text-destructive" : "text-foreground")}
        >
          {result.text}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows === null && !error && <p className="text-sm text-muted-foreground">Loading...</p>}
      {rows?.length === 0 && <p className="text-sm text-muted-foreground max-w-[62ch]">{empty}</p>}

      {rows && rows.length > 0 && (
        <>
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left text-[10px] font-bold caps text-muted-foreground">
                  <th scope="col" className="pb-1.5 pr-2.5 border-b border-line/30 font-bold">
                    Status
                  </th>
                  <th scope="col" className="pb-1.5 pr-2.5 border-b border-line/30 font-bold">
                    Request
                  </th>
                  {showSentColumn && (
                    <th
                      scope="col"
                      title="From the sender's own timestamp to our receipt"
                      className="pb-1.5 pr-2.5 border-b border-line/30 font-bold whitespace-nowrap"
                    >
                      Sent to received
                    </th>
                  )}
                  <th scope="col" className="pb-1.5 pr-2.5 border-b border-line/30 font-bold">
                    Answer
                  </th>
                  <th
                    scope="col"
                    title="From capture to the accepted delivery"
                    className="pb-1.5 pr-2.5 border-b border-line/30 font-bold whitespace-nowrap"
                  >
                    Delivered after
                  </th>
                  <th
                    scope="col"
                    title="How long your server took to answer the last try"
                    className="hidden md:table-cell pb-1.5 pr-2.5 border-b border-line/30 font-bold whitespace-nowrap"
                  >
                    Server took
                  </th>
                  <th scope="col" className="pb-1.5 pr-2.5 border-b border-line/30 font-bold">
                    Received
                  </th>
                  <th scope="col" className="pb-1.5 border-b border-line/30 font-bold">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isEmail = row.kind === "email";
                  const name = isEmail ? row.subject || "(no subject)" : (row.path ?? "");
                  const method = isEmail ? "EMAIL" : (row.method ?? "POST");
                  const answer = describeAnswer(row.lastStatus, row.lastError, row.attempts);
                  const sent = senderTimeFromRecord(row.senderAt, row.senderSource);
                  const received = row.receivedAt ?? row.createdAt;
                  const lag = sent ? formatSenderLag(sent, received) : null;
                  const behind = lag ? lag.startsWith("-") || lag.startsWith("about -") : false;
                  return (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      aria-label={`Open the deliveries of ${isEmail ? name : `${method} ${name}`}`}
                      onClick={() => open(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open(row);
                        }
                      }}
                      className="cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <td className={cell}>
                        <DeliveryChip status={chipStatus(row.status, row.attempts)} />
                      </td>
                      <td className={cn(cell, "min-w-0 whitespace-nowrap")}>
                        <span
                          className={cn(
                            "inline-block px-1.5 py-0.5 text-[10px] font-mono font-bold rounded-sm border-strong border-line clean:border-transparent w-14 text-center align-middle",
                            getMethodColor(method)
                          )}
                        >
                          {method}
                        </span>
                        <span
                          className={cn(
                            "inline-block align-middle ml-1.5 max-w-[120px] md:max-w-[170px] truncate",
                            isEmail ? "text-[13px]" : "font-mono text-xs"
                          )}
                          title={name}
                        >
                          {name}
                        </span>
                      </td>
                      {showSentColumn && (
                        <td
                          className={cn(num, behind && "text-destructive")}
                          title={
                            behind
                              ? "The sender's clock is ahead of ours."
                              : "From the sender's own timestamp to our receipt"
                          }
                        >
                          {lag ?? ""}
                        </td>
                      )}
                      <td
                        className={cn(
                          num,
                          answer.kind !== "status" && answer.kind !== "none" && "text-destructive",
                          answer.kind === "status" &&
                            row.lastStatus !== null &&
                            (row.lastStatus < 200 || row.lastStatus >= 300) &&
                            "text-destructive"
                        )}
                      >
                        {answer.label}
                      </td>
                      <td className={num}>
                        <DeliveredAfter row={row} now={now} />
                      </td>
                      <td className={cn(num, "hidden md:table-cell")}>
                        {row.lastDurationMs !== null && row.attempts > 0
                          ? formatDuration(row.lastDurationMs)
                          : ""}
                      </td>
                      <td className={cn(num, "text-muted-foreground")}>
                        {formatClock(received, { wholeSeconds: true, now })}
                      </td>
                      <td className={cn(cell, "pr-0 w-[1%] text-muted-foreground")}>
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              {olderLoaded && total !== undefined
                ? `Showing ${formatCount(rows.length)} of ${formatCappedCount(Math.max(total, rows.length))}.`
                : `Showing the latest ${formatCount(rows.length)}.`}
            </span>
            {!exhausted && (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className={cn(
                  "ui-btn-outline py-1! px-2.5! text-xs",
                  loadingOlder && "opacity-50 cursor-not-allowed"
                )}
              >
                {loadingOlder ? "Loading..." : "Show older"}
              </button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
