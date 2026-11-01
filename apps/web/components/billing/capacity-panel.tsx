"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice, Panel, PanelRow, settingsLink } from "@/components/settings/panel";
import { longDate } from "@/components/settings/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BlockAmountPicker } from "@/components/billing/block-amount-picker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BLOCK_REQUESTS,
  DEFAULT_OVERAGE_MAX_REQUESTS,
  MAX_BLOCKS,
  MONTHLY_BLOCK_CENTS,
  ONE_TIME_BLOCK_CENTS,
  OVERAGE_BLOCK_CENTS,
  overageCents,
} from "@/lib/capacity";
import { changeCapacity, fetchCapacity } from "@/lib/capacity-api";
import type { CapacityAction } from "@/lib/capacity-route";
import type { CapacityState } from "@/lib/supabase/capacity-billing";
import { formatCents } from "@/lib/team-pricing";

/** Overage maximums offered, in blocks of 25,000 ($4 each). */
const OVERAGE_MAX_OPTIONS = [5, 10, 25, 50, 100, 250];

function requests(count: number): string {
  return count.toLocaleString("en-US");
}

function blocksLabel(blocks: number): string {
  return `${blocks} ${blocks === 1 ? "block" : "blocks"}`;
}

interface PendingChange {
  title: string;
  body: React.ReactNode;
  confirm: string;
  action: CapacityAction;
}

/**
 * Extra requests on top of a plan: monthly blocks, one-time blocks and
 * overage (lib/capacity.ts). For the account itself, or a team pool when
 * `teamId` is set. Changes need the owner (`canManage`); a checkout leaves
 * the page and comes back with `?capacity=`.
 */
export function CapacityPanel({
  accessToken,
  teamId,
  canManage,
  onChanged,
  reloadKey,
}: {
  accessToken: string | null;
  teamId?: string;
  canManage: boolean;
  onChanged?: () => void;
  /** Changes when the plan or the add-ons change elsewhere, so the panel reads again. */
  reloadKey?: string;
}) {
  const [state, setState] = useState<CapacityState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  /** Monthly blocks to have; null until the current count is known. */
  const [monthlyBlocks, setMonthlyBlocks] = useState<number | null>(null);
  const [oneTimeBlocks, setOneTimeBlocks] = useState(1);
  const [overageMaxBlocks, setOverageMaxBlocks] = useState(
    String(DEFAULT_OVERAGE_MAX_REQUESTS / BLOCK_REQUESTS)
  );
  const [returned, setReturned] = useState<string | null>(null);
  // Once the customer picks a maximum, a background reload must not undo it.
  const overageMaxPicked = useRef(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const next = await fetchCapacity(accessToken, teamId);
      setState(next);
      setLoadError(null);
      setMonthlyBlocks((current) =>
        current === null ? (next.blocks?.pendingUnits ?? next.blocks?.units ?? 0) : current
      );
      if (next.overage.maxRequests > 0 && !overageMaxPicked.current) {
        setOverageMaxBlocks(String(Math.round(next.overage.maxRequests / BLOCK_REQUESTS)));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load extra requests");
    }
  }, [accessToken, teamId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Back from a Polar checkout: the purchase lands with Polar's webhook, a
  // few seconds later, so look again a few times.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const capacity = params.get("capacity");
    // Back from buying parsed pages: that panel's to say.
    if (!capacity || window.location.hash === "#extra-pages") return;
    setReturned(capacity);
    params.delete("capacity");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
    const timers = [3_000, 8_000, 20_000].map((delay) =>
      setTimeout(() => {
        void load();
        onChanged?.();
      }, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [load, onChanged]);

  const run = async (action: CapacityAction) => {
    if (!accessToken) {
      setActionError("Your session expired. Please sign in again.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await changeCapacity(accessToken, action, teamId);
      if ("url" in result) {
        window.location.href = result.url;
        return;
      }
      setState(result.state);
      setMonthlyBlocks(result.state.blocks?.pendingUnits ?? result.state.blocks?.units ?? 0);
      onChanged?.();
      setPending(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update extra requests");
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <Panel id="extra-requests" title="Extra requests">
        <p className="text-sm text-muted-foreground">{loadError}</p>
      </Panel>
    );
  }
  if (!state || !state.offered) return null;

  // Without a live plan only one-time blocks left over from it are shown.
  if (!state.eligible && state.creditRequests <= 0) return null;

  const renewal = state.periodEnd ? longDate(state.periodEnd) : "the renewal";
  const blocks = state.blocks;
  const currentUnits = blocks?.units ?? 0;
  const renewsWith = blocks?.pendingUnits ?? currentUnits;
  const manage = canManage && state.eligible;
  // Monthly blocks and overage end with a plan that is set to end, so they
  // cannot be started or kept until the plan is kept.
  const manageRenewing = manage && !state.planEnding;

  const proposeMonthly = () => {
    const target = monthlyBlocks ?? 0;
    if (!Number.isInteger(target) || target < 0 || target > MAX_BLOCKS) {
      setActionError(`Choose up to ${requests(MAX_BLOCKS * BLOCK_REQUESTS)} requests.`);
      return;
    }
    const action: CapacityAction = { action: "set_monthly_blocks", blocks: target };
    if (!blocks) {
      if (target === 0) return;
      setPending({
        title: `Add ${blocksLabel(target)} a month`,
        body: (
          <>
            {requests(target * BLOCK_REQUESTS)} more requests every period, starting now. You pay{" "}
            {formatCents(target * MONTHLY_BLOCK_CENTS)} today for the rest of this period, and the
            blocks then renew with your plan on {renewal} at{" "}
            {formatCents(target * MONTHLY_BLOCK_CENTS)} a month.
          </>
        ),
        confirm: "Continue to payment",
        action,
      });
    } else if (target > currentUnits) {
      const added = target - currentUnits;
      setPending({
        title: `Add ${blocksLabel(added)} a month`,
        body: (
          <>
            {requests(added * BLOCK_REQUESTS)} more requests now. You pay the full monthly price for
            them today ({formatCents(added * MONTHLY_BLOCK_CENTS)}), and from {renewal} your{" "}
            {blocksLabel(target)} renew at {formatCents(target * MONTHLY_BLOCK_CENTS)} a month.
            {blocks.pendingUnits !== null &&
              blocks.pendingUnits < currentUnits &&
              " This replaces the reduction you scheduled."}
          </>
        ),
        confirm: "Continue to payment",
        action,
      });
    } else if (target === currentUnits) {
      if (
        !blocks.cancelAtPeriodEnd &&
        (blocks.pendingUnits === null || blocks.pendingUnits === currentUnits)
      ) {
        // Looks unchanged here, but Polar has the last word on what renews
        // (nothing is charged): the server checks and fixes it if needed.
        void run(action);
        return;
      }
      setPending({
        title: `Keep ${blocksLabel(target)} a month`,
        body: (
          <>
            {blocks.cancelAtPeriodEnd
              ? "They were set to end; instead they "
              : "This drops the reduction you scheduled; they "}
            renew with your plan on {renewal} at {formatCents(target * MONTHLY_BLOCK_CENTS)} a
            month.
          </>
        ),
        confirm: "Keep them",
        action,
      });
    } else if (target === 0) {
      setPending({
        title: "End monthly blocks",
        body: (
          <>
            You keep your {blocksLabel(currentUnits)} until {renewal}; they are not renewed.
          </>
        ),
        confirm: "End at renewal",
        action,
      });
    } else {
      setPending({
        title: `${blocksLabel(target)} from ${renewal}`,
        body: (
          <>
            You keep {blocksLabel(currentUnits)} until {renewal}. After that you have{" "}
            {blocksLabel(target)}, at {formatCents(target * MONTHLY_BLOCK_CENTS)} a month.
          </>
        ),
        confirm: "Schedule the change",
        action,
      });
    }
  };

  const proposeOneTime = () => {
    const count = oneTimeBlocks;
    if (!Number.isInteger(count) || count < 1 || count > MAX_BLOCKS) {
      setActionError(
        `Choose between 25,000 and ${requests(MAX_BLOCKS * BLOCK_REQUESTS)} requests.`
      );
      return;
    }
    setPending({
      title: `Buy ${blocksLabel(count)}`,
      body: (
        <>
          {requests(count * BLOCK_REQUESTS)} requests for{" "}
          {formatCents(count * ONE_TIME_BLOCK_CENTS)}, used after your plan&apos;s requests and
          monthly blocks run out. They never expire.
        </>
      ),
      confirm: "Continue to payment",
      action: { action: "buy_blocks", blocks: count },
    });
  };

  const maxBlocks = Number(overageMaxBlocks);
  const overage = state.overage;
  const overageOn = overage.subscribed && overage.maxRequests > 0 && !overage.cancelAtPeriodEnd;

  return (
    <Panel
      id="extra-requests"
      title="Extra requests"
      description="When the plan's requests run out, these are used in order: monthly blocks, then one-time blocks, then overage. Without any, webhooks are turned away with HTTP 429 until the period resets."
    >
      <div className="space-y-4">
        {returned && (
          <Notice
            tone="success"
            title={returned === "overage" ? "Overage is being set up" : "Thanks, payment received"}
            action={
              <Button variant="ghost" size="sm" onClick={() => setReturned(null)}>
                Dismiss
              </Button>
            }
          >
            {returned === "overage"
              ? "Nothing was charged. It shows as on here as soon as Polar confirms it, usually within a few seconds."
              : "It shows here as soon as Polar confirms it, usually within a few seconds."}
          </Notice>
        )}
        {state.planEnding && (
          <Notice tone="warning" title={`Monthly blocks and overage end on ${renewal}`}>
            {teamId
              ? "The team's subscription is set to end, and they end with it. Keep the subscription to change them; one-time blocks stay with the team."
              : "Pro is set to end, and they end with it. Keep Pro to change them; one-time blocks stay with your account."}
          </Notice>
        )}
        {actionError && (
          <p className="text-sm text-destructive" role="alert" aria-live="polite">
            {actionError}
          </p>
        )}

        <div>
          <PanelRow
            label="Monthly blocks"
            hint={`${formatCents(MONTHLY_BLOCK_CENTS)} per 25,000 a month, renewed with the plan`}
          >
            <div className="space-y-2">
              <p>
                {currentUnits > 0 ? (
                  <>
                    <span className="font-medium">{blocksLabel(currentUnits)}</span>:{" "}
                    {requests(currentUnits * BLOCK_REQUESTS)} more requests this period
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </p>
              {blocks?.cancelAtPeriodEnd && !state.planEnding && (
                <p className="text-muted-foreground">Ends on {renewal}.</p>
              )}
              {blocks && !blocks.cancelAtPeriodEnd && renewsWith !== currentUnits && (
                <p className="text-muted-foreground">
                  From {renewal}: {blocksLabel(renewsWith)}.
                </p>
              )}
              {blocks?.pastDue && (
                <p className="text-destructive">
                  The last payment failed. Update your card from the Polar receipt email.
                </p>
              )}
              {manageRenewing && (
                <div className="pt-1">
                  <BlockAmountPicker
                    label="Extra requests a month"
                    blocks={monthlyBlocks ?? 0}
                    onBlocksChange={setMonthlyBlocks}
                    blockPriceCents={MONTHLY_BLOCK_CENTS}
                    perMonth
                    disabled={busy}
                  >
                    <Button variant="outline" size="sm" onClick={proposeMonthly} disabled={busy}>
                      {blocks ? "Change" : "Add"}
                    </Button>
                  </BlockAmountPicker>
                </div>
              )}
            </div>
          </PanelRow>

          <PanelRow
            label="One-time blocks"
            hint={`${formatCents(ONE_TIME_BLOCK_CENTS)} per 25,000, kept until used`}
          >
            <div className="space-y-2">
              <p>
                {state.creditRequests > 0 ? (
                  <>
                    <span className="font-medium">{requests(state.creditRequests)}</span> requests
                    left
                  </>
                ) : (
                  <span className="text-muted-foreground">None left</span>
                )}
              </p>
              {manage && (
                <div className="pt-1">
                  <BlockAmountPicker
                    label="One-time requests to buy"
                    blocks={oneTimeBlocks}
                    onBlocksChange={setOneTimeBlocks}
                    minBlocks={1}
                    blockPriceCents={ONE_TIME_BLOCK_CENTS}
                    disabled={busy}
                  >
                    <Button variant="outline" size="sm" onClick={proposeOneTime} disabled={busy}>
                      Buy
                    </Button>
                  </BlockAmountPicker>
                </div>
              )}
            </div>
          </PanelRow>

          {state.eligible && (
            <PanelRow
              label="Overage"
              hint={`${formatCents(OVERAGE_BLOCK_CENTS)} per 25,000 used, billed at the end of the period`}
            >
              <div className="space-y-2">
                {overageOn ? (
                  <p>
                    <span className="font-medium">On</span>: {requests(overage.usedRequests)} of up
                    to {requests(overage.maxRequests)} this period (
                    {formatCents(overageCents(overage.usedRequests))} so far, at most{" "}
                    {formatCents(overageCents(overage.maxRequests))})
                  </p>
                ) : overage.subscribed && overage.cancelAtPeriodEnd ? (
                  <p>
                    <span className="font-medium">Off</span>
                    {overage.usedRequests > 0 && (
                      <span className="text-muted-foreground">
                        : the {requests(overage.usedRequests)} used this period are billed on{" "}
                        {renewal} ({formatCents(overageCents(overage.usedRequests))}).
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Off</p>
                )}
                {overage.pastDue && (
                  <p className="text-destructive">
                    The last overage payment failed, so overage is paused. Update your card from the
                    Polar receipt email.
                  </p>
                )}
                {manageRenewing && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={overageMaxBlocks}
                      onValueChange={(value) => {
                        overageMaxPicked.current = true;
                        setOverageMaxBlocks(value);
                      }}
                    >
                      <SelectTrigger className="w-56" aria-label="Overage maximum per period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[...new Set([...OVERAGE_MAX_OPTIONS, Number(overageMaxBlocks)])]
                          .filter((option) => Number.isInteger(option) && option > 0)
                          .sort((a, b) => a - b)
                          .map((option) => (
                            <SelectItem key={option} value={String(option)}>
                              Up to {formatCents(option * OVERAGE_BLOCK_CENTS)} (
                              {requests(option * BLOCK_REQUESTS)})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        overage.subscribed
                          ? void run({ action: "set_overage", enabled: true, maxBlocks })
                          : setPending({
                              title: "Turn on overage",
                              body: (
                                <>
                                  Once everything else is used up, up to{" "}
                                  {requests(maxBlocks * BLOCK_REQUESTS)} more requests each period
                                  at {formatCents(OVERAGE_BLOCK_CENTS)} per 25,000, billed with the
                                  plan at the end of the period: at most{" "}
                                  {formatCents(maxBlocks * OVERAGE_BLOCK_CENTS)}. Nothing is charged
                                  now; Polar asks for a card to bill it to.
                                </>
                              ),
                              confirm: "Continue",
                              action: { action: "set_overage", enabled: true, maxBlocks },
                            })
                      }
                    >
                      {overageOn ? "Save maximum" : "Turn on"}
                    </Button>
                    {overageOn && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setPending({
                            title: "Turn off overage",
                            body: (
                              <>
                                Requests past your plan and blocks are turned away with HTTP 429
                                from now on. Overage already used is billed on {renewal}.
                              </>
                            ),
                            confirm: "Turn off",
                            action: { action: "set_overage", enabled: false },
                          })
                        }
                      >
                        Turn off
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </PanelRow>
          )}
        </div>

        {!canManage && state.eligible && (
          <p className="text-xs text-muted-foreground">Only the team owner can change these.</p>
        )}
        {!state.eligible && (
          <p className="text-xs text-muted-foreground">
            Monthly blocks and overage come with a paid plan.{" "}
            {teamId ? null : (
              <a href="/account/plan#plan" className={settingsLink}>
                Upgrade to Pro
              </a>
            )}
          </p>
        )}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (pending) void run(pending.action);
              }}
            >
              {busy ? "Working..." : pending?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
