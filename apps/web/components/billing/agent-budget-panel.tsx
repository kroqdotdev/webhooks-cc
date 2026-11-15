"use client";

import { useCallback, useEffect, useState } from "react";
import { InlineMessage, Panel, PanelRow } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
import { longDate } from "@/lib/dates";
import {
  AGENT_BUDGET_RENEWAL_NOTE,
  agentBudgetDescription,
} from "@/lib/billing/agent-budget-words";
import { formatCents } from "@/lib/team-pricing";
import { cn } from "@/lib/utils";

/** What `GET .../billing/agent-budget` answers (lib/billing/agent-budget-route.ts). */
interface AgentBudgetView {
  budgetCents: number;
  spentCents: number;
  leftCents: number;
  nextReleaseAt: string | null;
  windowDays: number;
  maxCents: number;
  note: string;
  spends: Array<{
    id: string;
    change: string;
    amountCents: number;
    status: "running" | "applied" | "unsettled" | "returned";
    takenAt: string;
  }>;
}

const STATUS_WORDS: Record<AgentBudgetView["spends"][number]["status"], string> = {
  running: "Being made",
  applied: "Made",
  unsettled: "Waiting for Polar",
  returned: "Refused, given back",
};

function budgetUrl(teamId?: string): string {
  return teamId
    ? `/api/teams/${encodeURIComponent(teamId)}/billing/agent-budget`
    : "/api/billing/agent-budget";
}

/** Dollars as typed ("50", "12.50") to cents, or null. */
function parseDollars(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function dollarsField(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * The agent spend budget of the account or a team (its owner only): how
 * much API keys and agents may charge at once without asking (each change
 * counted for 30 days or more),
 * what they spent, and the spends. Set in a session, so it takes effect at
 * once; the server emails the owner whenever it goes up. `plan` is the
 * person's own plan, for their own budget.
 */
export function AgentBudgetPanel({
  accessToken,
  teamId,
  plan,
  reloadKey,
}: {
  accessToken: string | null;
  teamId?: string;
  plan?: string;
  reloadKey?: string;
}) {
  const [view, setView] = useState<AgentBudgetView | null>(null);
  const [field, setField] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch(budgetUrl(teamId), {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("The agent budget could not be loaded");
      const next = (await response.json()) as AgentBudgetView;
      setView(next);
      setField(dollarsField(next.budgetCents));
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [accessToken, teamId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const save = async (cents: number) => {
    if (!accessToken) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(budgetUrl(teamId), {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ budgetCents: cents }),
      });
      const data = (await response.json().catch(() => null)) as
        (AgentBudgetView & { error?: string }) | null;
      if (!response.ok || !data) {
        throw new Error(data?.error ?? "The budget could not be saved");
      }
      setView(data);
      setField(dollarsField(data.budgetCents));
      setMessage({
        tone: "success",
        text:
          data.budgetCents === 0
            ? "Agent budget turned off."
            : `Agent budget saved: ${formatCents(data.budgetCents)} per 30 days.`,
      });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const typed = parseDollars(field);
  const max = view?.maxCents ?? 50_000;
  const invalid = field.trim() !== "" && (typed === null || typed > max);
  const unchanged = view !== null && typed === view.budgetCents;
  const on = (view?.budgetCents ?? 0) > 0;
  const percent =
    view && view.budgetCents > 0
      ? Math.min(100, Math.round((view.spentCents / view.budgetCents) * 100))
      : 0;
  const inputId = teamId ? `agent-budget-amount-${teamId}` : "agent-budget-amount";

  return (
    <Panel
      id="agent-budget"
      title="Agent spend budget"
      description={agentBudgetDescription(teamId, plan)}
      footer={message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}
    >
      <PanelRow
        label="Budget"
        htmlFor={inputId}
        hint={`Per 30 days, before tax. 0 turns it off; at most ${formatCents(max)}.`}
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed !== null && !invalid) void save(typed);
          }}
        >
          <div className="relative w-32">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground"
            >
              $
            </span>
            <Input
              id={inputId}
              field
              inputMode="decimal"
              autoComplete="off"
              value={field}
              disabled={!view || busy}
              aria-invalid={invalid || undefined}
              onChange={(event) => setField(event.target.value)}
              className="pl-6 tabular-nums"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            raised
            disabled={!view || busy || invalid || typed === null || unchanged}
          >
            {busy ? "Saving..." : "Save budget"}
          </Button>
          {on && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void save(0)}
            >
              Turn off
            </Button>
          )}
        </form>
        {invalid && (
          <p className="mt-2 text-xs text-destructive-ink">
            Give dollars, such as 50 or 12.50, up to {formatCents(max)}.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground max-w-[60ch]">
          {view?.note ?? AGENT_BUDGET_RENEWAL_NOTE} Annual billing, a lower plan, cancelling,
          overage and add-ons paid at a checkout still wait for your approval.
        </p>
      </PanelRow>

      {view && on && (
        <PanelRow
          label="Spent"
          hint={
            view.nextReleaseAt
              ? `More is left from ${longDate(view.nextReleaseAt)}`
              : "In the last 30 days"
          }
        >
          <div className="space-y-1.5">
            <Meter
              value={percent}
              aria-label={`${formatCents(view.spentCents)} of ${formatCents(view.budgetCents)} spent`}
              className="h-2 overflow-hidden rounded-sm bg-muted/60"
            >
              <div
                aria-hidden="true"
                className={cn("h-full", percent >= 90 ? "bg-destructive" : "bg-primary")}
                style={{ width: `${Math.max(percent, view.spentCents > 0 ? 1 : 0)}%` }}
              />
            </Meter>
            <p className="text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{formatCents(view.spentCents)}</span> of{" "}
              {formatCents(view.budgetCents)}, {formatCents(view.leftCents)} left
            </p>
          </div>
        </PanelRow>
      )}

      {view && view.spends.length > 0 && (
        <PanelRow
          label="Changes made on it"
          hint="The last 30 days and any still counted, each at its charge now plus the rise of the next renewal when near"
        >
          <ul className="divide-y divide-border/60 ph-no-capture">
            {view.spends.map((spend) => (
              <li
                key={spend.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="break-words">{spend.change}</p>
                  <p className="text-xs text-muted-foreground">
                    {longDate(spend.takenAt)}, {STATUS_WORDS[spend.status]}
                  </p>
                </div>
                <span
                  className={cn(
                    "tabular-nums",
                    spend.status === "returned" && "text-muted-foreground line-through"
                  )}
                >
                  {formatCents(spend.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </PanelRow>
      )}
    </Panel>
  );
}
