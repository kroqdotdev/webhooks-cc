"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice, Panel, PanelRow } from "@/components/settings/panel";
import { longDate } from "@/components/settings/format";
import { Button } from "@/components/ui/button";
import {
  BLOCK_PAGES,
  DEFAULT_PAGE_OVERAGE_MAX_PAGES,
  MAX_PAGE_BLOCKS,
  MONTHLY_PAGE_BLOCK_CENTS,
  ONE_TIME_PAGE_BLOCK_CENTS,
  PAGE_OVERAGE_CENTS,
} from "@/lib/capacity";
import { changeCapacity, fetchCapacity } from "@/lib/capacity-api";
import type { CapacityAction } from "@/lib/capacity-route";
import type { CapacityState } from "@/lib/supabase/capacity-billing";
import { formatCents } from "@/lib/team-pricing";

/** Page overage maximums offered, in thousands of pages ($10 each). */
const OVERAGE_MAX_OPTIONS = [2, 5, 10, 25, 50, 100];

function pages(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * Parsed attachment pages: what the plan includes this month and what is
 * used, and for Business (or a team with Team Business) the same three ways
 * to get more as requests: monthly page blocks, one-time page blocks and
 * page overage. The numbers come from parsed_pages_balance(), the ones a
 * parse is charged against.
 */
export function ParsedPagesPanel({
  accessToken,
  teamId,
  canManage,
  reloadKey,
}: {
  accessToken: string | null;
  teamId?: string;
  canManage: boolean;
  reloadKey?: string;
}) {
  const [state, setState] = useState<CapacityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [monthly, setMonthly] = useState<string | null>(null);
  const [oneTime, setOneTime] = useState("1");
  const [overageMax, setOverageMax] = useState(
    String(DEFAULT_PAGE_OVERAGE_MAX_PAGES / BLOCK_PAGES)
  );
  const [returned, setReturned] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const next = await fetchCapacity(accessToken, teamId, "pages");
      setState(next);
      setMonthly((current) =>
        current === null ? String(next.blocks?.pendingUnits ?? next.blocks?.units ?? 0) : current
      );
      if (next.overage.maxRequests > 0) {
        setOverageMax(String(Math.round(next.overage.maxRequests / BLOCK_PAGES)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load parsed pages");
    }
  }, [accessToken, teamId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Back from a checkout for pages: the purchase lands with Polar's webhook.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get("capacity") || window.location.hash !== "#extra-pages") return;
    setReturned(true);
    params.delete("capacity");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}#extra-pages`
    );
    const timers = [3000, 8000, 15000].map((ms) => setTimeout(() => void load(), ms));
    return () => timers.forEach(clearTimeout);
  }, [load]);

  const act = async (action: CapacityAction) => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      const result = await changeCapacity(accessToken, { ...action, resource: "pages" }, teamId);
      if ("url" in result) {
        window.location.assign(result.url);
        return;
      }
      setState(result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change was not made");
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return error ? (
      <Panel id="extra-pages" title="Parsed pages">
        <p className="text-sm text-destructive">{error}</p>
      </Panel>
    ) : null;
  }

  const allowance = state.planRequests + state.blockRequests;
  const monthlyBlocks = Number(monthly ?? 0);
  const monthlyValid =
    Number.isInteger(monthlyBlocks) && monthlyBlocks >= 0 && monthlyBlocks <= MAX_PAGE_BLOCKS;
  const oneTimeBlocks = Number(oneTime);
  const oneTimeValid =
    Number.isInteger(oneTimeBlocks) && oneTimeBlocks >= 1 && oneTimeBlocks <= MAX_PAGE_BLOCKS;
  const manage = canManage && state.offered && state.eligible;
  const renewal = state.periodEnd ? longDate(state.periodEnd) : "the renewal";

  return (
    <Panel
      id="extra-pages"
      title="Parsed pages"
      description="Attachments a layout parses use pages: each started 1,000 rows of a sheet, each PDF page, each text file. Past them, attachments still arrive as files, unparsed."
    >
      {returned && (
        <Notice tone="success" title="Thanks">
          Your purchase shows here once Polar confirms it, usually within a minute.
        </Notice>
      )}
      <PanelRow
        label="This month"
        hint={state.periodEnd ? `Until ${longDate(state.periodEnd)}` : undefined}
      >
        <p className="text-sm">
          <span className="font-medium">{pages(state.used)}</span> of {pages(allowance)} pages used
          {state.blockRequests > 0 && (
            <span className="text-muted-foreground">
              {" "}
              ({pages(state.blockRequests)} from monthly blocks)
            </span>
          )}
        </p>
        {state.creditRequests > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Plus {pages(state.creditRequests)} one-time pages, used after these.
          </p>
        )}
        {state.overage.active && (
          <p className="text-xs text-muted-foreground mt-1">
            Overage: {pages(state.overage.usedRequests)} of up to {pages(state.overage.maxRequests)}{" "}
            pages this period, at {formatCents(PAGE_OVERAGE_CENTS * 100)} per 100 pages.
          </p>
        )}
      </PanelRow>

      {!state.eligible && state.offered && (
        <p className="text-sm text-muted-foreground">
          {teamId
            ? "More parsed pages come with Team Business."
            : "More parsed pages are part of Business: 2,000 a month included, then blocks of 1,000 or overage."}
        </p>
      )}

      {manage && state.planEnding && (
        <Notice tone="warning" title={`Extra pages end on ${renewal}`}>
          {teamId
            ? "Team Business is set to end, and monthly page blocks and overage end with it. Keep Team Business to change them."
            : "Your plan leaves Business then, and monthly page blocks and overage end with it. Keep Business to change them."}{" "}
          One-time pages stay.
        </Notice>
      )}

      {manage && (
        <>
          <PanelRow
            label="Monthly blocks"
            htmlFor="monthly-page-blocks"
            hint={`${formatCents(MONTHLY_PAGE_BLOCK_CENTS)} per 1,000 pages a month, renewed with your plan. Adding blocks charges them in full now; fewer apply at the renewal.`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="monthly-page-blocks"
                type="number"
                min={0}
                max={MAX_PAGE_BLOCKS}
                value={monthly ?? ""}
                onChange={(e) => setMonthly(e.target.value)}
                className="ui-input w-24 text-sm py-1.5!"
              />
              <span className="text-sm text-muted-foreground">
                x 1,000 pages (
                {formatCents(MONTHLY_PAGE_BLOCK_CENTS * (monthlyValid ? monthlyBlocks : 0))} a
                month)
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !monthlyValid || state.planEnding}
                onClick={() => void act({ action: "set_monthly_blocks", blocks: monthlyBlocks })}
              >
                {state.blocks?.cancelAtPeriodEnd && !state.planEnding ? "Keep" : "Save"}
              </Button>
            </div>
            {state.blocks?.cancelAtPeriodEnd && (
              <p className="text-xs text-muted-foreground mt-1">
                {pages(state.blocks.units * BLOCK_PAGES)} pages a month until {renewal}, not
                renewed.
              </p>
            )}
            {state.blocks?.pendingUnits !== null &&
              state.blocks?.pendingUnits !== undefined &&
              state.blocks.pendingUnits !== state.blocks.units && (
                <p className="text-xs text-muted-foreground mt-1">
                  {pages(state.blocks.pendingUnits * BLOCK_PAGES)} pages from the renewal.
                </p>
              )}
          </PanelRow>

          <PanelRow
            label="One-time blocks"
            htmlFor="one-time-page-blocks"
            hint={`${formatCents(ONE_TIME_PAGE_BLOCK_CENTS)} per 1,000 pages. Used after your monthly pages, and kept until used.`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="one-time-page-blocks"
                type="number"
                min={1}
                max={MAX_PAGE_BLOCKS}
                value={oneTime}
                onChange={(e) => setOneTime(e.target.value)}
                className="ui-input w-24 text-sm py-1.5!"
              />
              <span className="text-sm text-muted-foreground">x 1,000 pages</span>
              <Button
                size="sm"
                disabled={busy || !oneTimeValid}
                onClick={() => void act({ action: "buy_blocks", blocks: oneTimeBlocks })}
              >
                Buy for{" "}
                {formatCents(ONE_TIME_PAGE_BLOCK_CENTS * (oneTimeValid ? oneTimeBlocks : 0))}
              </Button>
            </div>
          </PanelRow>

          <PanelRow
            label="Overage"
            htmlFor="page-overage-max"
            hint="Pages past everything else, at $0.01 each, billed at the end of the period, up to the most you set."
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="page-overage-max"
                value={overageMax}
                onChange={(e) => setOverageMax(e.target.value)}
                className="ui-input text-sm py-1.5!"
              >
                {OVERAGE_MAX_OPTIONS.map((thousands) => (
                  <option key={thousands} value={String(thousands)}>
                    Up to {pages(thousands * BLOCK_PAGES)} pages (
                    {formatCents(thousands * BLOCK_PAGES * PAGE_OVERAGE_CENTS)})
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant={
                  state.overage.subscribed && !state.overage.cancelAtPeriodEnd
                    ? "outline"
                    : "default"
                }
                disabled={busy || state.planEnding}
                onClick={() =>
                  void act({ action: "set_overage", enabled: true, maxBlocks: Number(overageMax) })
                }
              >
                {state.overage.subscribed && !state.overage.cancelAtPeriodEnd
                  ? "Save maximum"
                  : "Turn on"}
              </Button>
              {state.overage.subscribed && !state.overage.cancelAtPeriodEnd && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act({ action: "set_overage", enabled: false })}
                >
                  Turn off
                </Button>
              )}
            </div>
            {state.overage.subscribed && state.overage.cancelAtPeriodEnd && (
              <p className="text-xs text-muted-foreground mt-1">On until {renewal}.</p>
            )}
          </PanelRow>
        </>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </Panel>
  );
}
