"use client";

import Link from "next/link";
import type { AllowanceUsage } from "@/lib/supabase/allowance-usage";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/types/request";
import { longDate } from "./format";
import { settingsLink } from "./panel";

/** At or above this share of an allowance, the bar and its count turn to the warning colour. */
const NEAR = 0.8;

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * One allowance: its name and when it frees up on the left, a slim bar and
 * the count on the right. The same grid as the team pools rows, so the
 * columns line up down the page.
 */
function AllowanceRow({
  name,
  href,
  when,
  used,
  limit,
  amount,
  extra,
  paused = false,
}: {
  name: string;
  /** Where this allowance is managed, when that is another place. */
  href?: string;
  /** When it resets or frees up, as a short phrase. */
  when: string | null;
  used: number;
  limit: number;
  /** "12 of 100 pages": the count in its own unit. */
  amount: { used: string; of: string };
  /** One more short fact, such as one-time pages on top. */
  extra?: string | null;
  /** Used up: shown as stopped, not merely near. */
  paused?: boolean;
}) {
  const share = limit > 0 ? Math.min(used / limit, 1) : used > 0 ? 1 : 0;
  const near = paused || share >= NEAR;
  const percent = Math.round(share * 100);
  return (
    <li className="grid gap-2 py-3.5 first:pt-0 last:pb-0 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {href ? (
            <Link href={href} className={settingsLink}>
              {name}
            </Link>
          ) : (
            name
          )}
        </p>
        {when && <p className="text-xs text-muted-foreground">{when}</p>}
      </div>
      <div className="min-w-0 space-y-1.5">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${name}: ${amount.used} of ${amount.of} used`}
          className="h-2 overflow-hidden rounded-sm bg-muted/60"
        >
          <div
            aria-hidden="true"
            className={cn("h-full", near ? "bg-destructive" : "bg-primary")}
            // A sliver for any use at all, so "1 of 2,000" never reads as none.
            style={{ width: `${Math.max(percent, used > 0 ? 1 : 0)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className={cn("font-medium", near ? "text-destructive-ink" : "text-foreground")}>
            {amount.used}
          </span>{" "}
          of {amount.of}
          {extra && <span>, {extra}</span>}
        </p>
      </div>
    </li>
  );
}

/**
 * The plan's allowances beside requests, under the request meter: parsed
 * pages, preview data and AI assists, each with its own window. An allowance
 * the server did not answer (not offered here, or not readable) is left out;
 * so is preview data on mailhooks.cc, which does not offer sharing.
 */
export function AllowanceMeters({
  allowances,
  showPreviewData,
}: {
  allowances: AllowanceUsage | null;
  showPreviewData: boolean;
}) {
  if (!allowances) return null;
  const { parsedPages, aiAssists } = allowances;
  const previewData = showPreviewData ? allowances.previewData : null;
  if (!parsedPages && !previewData && !aiAssists) return null;

  return (
    <ul aria-label="Other allowances" className="mt-6 border-t border-line/60 pt-5">
      {parsedPages && (
        <AllowanceRow
          name="Parsed pages"
          href="#extra-pages"
          when={
            parsedPages.resetsAt
              ? `Resets ${longDate(parsedPages.resetsAt)}`
              : "A month from your first parse"
          }
          used={parsedPages.used}
          limit={parsedPages.limit}
          amount={{ used: count(parsedPages.used), of: `${count(parsedPages.limit)} pages` }}
          extra={
            parsedPages.overage.active && parsedPages.overage.used > 0
              ? `${count(parsedPages.overage.used)} in overage`
              : parsedPages.creditPages > 0
                ? `plus ${count(parsedPages.creditPages)} one-time pages`
                : null
          }
        />
      )}
      {previewData && (
        <AllowanceRow
          name="Preview data"
          href="/account/shares"
          when={
            previewData.over
              ? `Previews paused until ${longDate(previewData.resetsAt)}`
              : `Resets ${longDate(previewData.resetsAt)}`
          }
          used={previewData.bytes}
          limit={previewData.limitBytes}
          amount={{
            used: formatBytes(previewData.bytes),
            of: `${formatBytes(previewData.limitBytes)} sent to visitors`,
          }}
          paused={previewData.over}
        />
      )}
      {aiAssists && (
        <AllowanceRow
          name="AI assists"
          when={
            // Assists count over a rolling 30 days, not a period: say when one
            // comes back only once none are left.
            aiAssists.used >= aiAssists.allowed && aiAssists.nextAt
              ? `Next one back ${longDate(aiAssists.nextAt)}`
              : "Over the last 30 days"
          }
          used={aiAssists.used}
          limit={aiAssists.allowed}
          amount={{ used: count(aiAssists.used), of: count(aiAssists.allowed) }}
        />
      )}
    </ul>
  );
}
