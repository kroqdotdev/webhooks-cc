"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { apiFetch, waitLabel } from "@/lib/support/client";
import type { MetricLine, OpsOverview as Overview } from "@/lib/ops/metrics";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";

const count = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function formatValue(line: MetricLine, value: number | null, average = false): string {
  if (value === null) return "–";
  if (line.format === "percent") return `${Math.round(value * 100)}%`;
  if (line.format === "cents") return `$${count.format(Math.round(value / 100))}`;
  if (average && !Number.isInteger(value))
    return value < 100 ? value.toFixed(1) : count.format(Math.round(value));
  return count.format(Math.round(value));
}

function change(line: MetricLine): { text: string; tone: "good" | "bad" | "flat" } {
  const { avg7, prev7 } = line;
  if (avg7 === null || prev7 === null) return { text: "–", tone: "flat" };
  if (line.format === "percent") {
    const points = Math.round((avg7 - prev7) * 100);
    if (points === 0) return { text: "0 pt", tone: "flat" };
    const good = points > 0 === line.higherIsBetter;
    return { text: `${points > 0 ? "+" : ""}${points} pt`, tone: good ? "good" : "bad" };
  }
  if (prev7 === 0) {
    if (avg7 === 0) return { text: "0%", tone: "flat" };
    return { text: "new", tone: line.higherIsBetter ? "good" : "bad" };
  }
  const pct = Math.round(((avg7 - prev7) / prev7) * 100);
  if (Math.abs(pct) < 2) return { text: `${pct > 0 ? "+" : ""}${pct}%`, tone: "flat" };
  const good = pct > 0 === line.higherIsBetter;
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, tone: good ? "good" : "bad" };
}

/** 28 days of shape, the last day marked. Gaps where a day has no value. */
function Sparkline({ series, label }: { series: (number | null)[]; label: string }) {
  const values = series.filter((value): value is number => value !== null);
  if (values.length < 2) return <span className="text-xs text-muted-foreground">–</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const width = 112;
  const height = 22;
  const step = width / (series.length - 1);
  const y = (value: number) => height - 3 - ((value - min) / span) * (height - 6);
  const segments: string[] = [];
  let current: string[] = [];
  series.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${(index * step).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  const last = series.at(-1);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="ml-auto block"
      role="img"
      aria-label={`${label}, last 28 days`}
    >
      {segments.map((points) => (
        <polyline
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          className="text-muted-foreground"
        />
      ))}
      {last !== null && last !== undefined && (
        <circle cx={width} cy={y(last)} r={2.25} className="fill-primary" />
      )}
    </svg>
  );
}

export function OpsOverview() {
  const { token } = useOps();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<Overview>(token, "/api/ops/overview"));
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "The overview could not be loaded."
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <div className="p-6 lg:p-8">
        {error ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-destructive-ink">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading" className="space-y-3">
            <Skeleton className="h-6 w-1/3 rounded-md" />
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
        )}
      </div>
    );
  }

  const yesterday = new Date(`${data.yesterday}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const asOf = new Date(data.today.asOf).toISOString().slice(11, 16);
  const needs = data.needs.tickets.length + data.needs.refunds.length;
  // Revenue rows split from usage rows by a slightly stronger rule.
  const firstMoney = data.lines.findIndex((line) => line.key === "paid");

  return (
    <div className="max-w-5xl space-y-8 p-6 lg:p-8">
      <section aria-labelledby="needs-you" className="space-y-2">
        <h1 id="needs-you" className="text-lg font-semibold">
          {needs === 0 ? "Nothing needs you" : "Needs you"}
        </h1>
        {needs > 0 && (
          <ul className="ui-card ui-card-static p-0! overflow-hidden ph-no-capture">
            {data.needs.tickets.map((ticket) => {
              const late = now - new Date(ticket.waitingSince).getTime() > 24 * 3_600_000;
              return (
                <li key={ticket.number} className="border-t border-border first:border-t-0">
                  <Link
                    href={`/ops/tickets/${ticket.number}`}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0 truncate">
                      {ticket.subject}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        #{ticket.number}
                      </span>
                      {ticket.blocking && (
                        <span className="ml-2 text-xs text-destructive-ink">blocking</span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-xs tabular-nums",
                        late ? "font-medium text-destructive-ink" : "text-muted-foreground"
                      )}
                    >
                      waiting {waitLabel(ticket.waitingSince)}
                    </span>
                  </Link>
                </li>
              );
            })}
            {data.needs.refunds.map((refund) => (
              <li key={refund.id} className="border-t border-border first:border-t-0">
                <Link
                  href="/ops/refunds"
                  className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm hover:bg-muted/60"
                >
                  <span>
                    Refund
                    {refund.plannedCents !== null
                      ? ` of $${(refund.plannedCents / 100).toFixed(2)}`
                      : ""}{" "}
                    held
                    {refund.reason ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({refund.reason.replace(/_/g, " ")})
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    held {waitLabel(refund.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="max-w-[62ch] text-[17px] leading-relaxed">
        So far{" "}
        <strong className="font-semibold tabular-nums">{count.format(data.totals.accounts)}</strong>{" "}
        accounts have made{" "}
        <strong className="font-semibold tabular-nums">
          {count.format(data.totals.endpoints)}
        </strong>{" "}
        endpoints and captured{" "}
        <strong className="font-semibold tabular-nums">
          {compact.format(data.totals.webhooks)}
        </strong>{" "}
        requests. Today, up to {asOf} UTC:{" "}
        <strong className="font-semibold tabular-nums">{count.format(data.today.signups)}</strong>{" "}
        signups and{" "}
        <strong className="font-semibold tabular-nums">{count.format(data.today.captured)}</strong>{" "}
        captures from{" "}
        <strong className="font-semibold tabular-nums">
          {count.format(data.today.activeAccounts)}
        </strong>{" "}
        accounts.
      </p>

      <section aria-labelledby="ledger" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ledger" className="text-base font-semibold">
            Yesterday, {yesterday}
          </h2>
          <span className="text-xs text-muted-foreground">
            Last 7 days against the 7 before, UTC
          </span>
        </div>
        <div className="ui-card ui-card-static p-0! overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="bg-muted/60 text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Metric
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Yesterday
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  7-day avg
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Previous 7
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Change
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Last 28 days
                </th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, index) => {
                const delta = change(line);
                return (
                  <tr
                    key={line.key}
                    className={cn(
                      "border-t border-border",
                      index === firstMoney && "border-t-foreground/25"
                    )}
                  >
                    <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">
                      {line.label}
                    </th>
                    <td className="px-3 py-2 text-right">{formatValue(line, line.yesterday)}</td>
                    <td className="px-3 py-2 text-right">{formatValue(line, line.avg7, true)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatValue(line, line.prev7, true)}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right",
                        delta.tone === "good" && "text-primary",
                        delta.tone === "bad" && "text-destructive-ink",
                        delta.tone === "flat" && "text-muted-foreground"
                      )}
                    >
                      {delta.text}
                    </td>
                    <td className="px-3 py-1.5">
                      <Sparkline series={line.series} label={line.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="max-w-[80ch] text-xs text-muted-foreground">
          Staff and internal test accounts are left out. Paying accounts and MRR are levels, so
          their averages show the last value of each week. MRR and subscriptions come from Polar and
          include add-on subscriptions. Activation is the share of accounts that signed up 7 days
          before a day and captured something within their first week.
        </p>
      </section>
    </div>
  );
}
