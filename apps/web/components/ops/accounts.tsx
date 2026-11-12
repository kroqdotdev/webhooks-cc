"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, shortDateTime, shortDay } from "@/lib/support/client";
import type { AccountDetail, AccountSummary } from "@/lib/ops/accounts";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";
import { AccountSharingPanel } from "./sharing";

const count = new Intl.NumberFormat("en-US");

function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function AccountSearch() {
  const { token } = useOps();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setResults(
          await apiFetch<AccountSummary[]>(
            token,
            `/api/ops/accounts?q=${encodeURIComponent(query)}`
          )
        );
        setError(null);
      } catch (searchError) {
        setError(searchError instanceof Error ? searchError.message : "The search failed.");
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, token]);

  return (
    <div className="max-w-4xl space-y-4 p-6 lg:p-8">
      <h1 className="text-lg font-semibold">Accounts</h1>
      <label htmlFor="account-search" className="sr-only">
        Search accounts
      </label>
      <Input
        id="account-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Email, account id or endpoint slug"
        autoFocus
      />
      {error && <p className="text-sm text-destructive-ink">{error}</p>}
      {results === null ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No account matches.</p>
      ) : (
        <ul className="ui-card ui-card-static p-0! overflow-hidden ph-no-capture">
          {results.map((account) => (
            <li key={account.id} className="border-t border-border first:border-t-0">
              <Link
                href={`/ops/accounts/${account.id}`}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-2.5 text-sm hover:bg-muted/60"
              >
                <span className="min-w-0 truncate">
                  {account.email}
                  {account.name && <span className="text-muted-foreground"> ({account.name})</span>}
                </span>
                <span className="text-xs text-muted-foreground">{planName(account.plan)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {shortDay(account.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Tab = "overview" | "endpoints" | "billing" | "activity" | "tickets";

export function AccountInspector({ id }: { id: string }) {
  const { token } = useOps();
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    try {
      setAccount(await apiFetch<AccountDetail>(token, `/api/ops/accounts/${id}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The account could not be loaded.");
    }
  }, [token, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleInternal = async () => {
    if (!account) return;
    try {
      await apiFetch(token, `/api/ops/accounts/${id}`, {
        method: "PATCH",
        json: { internal: !account.internal },
      });
      setAccount({ ...account, internal: !account.internal });
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : "The change could not be saved."
      );
    }
  };

  const resetTwoFactor = async () => {
    if (!account) return;
    if (
      !window.confirm(`Turn off two-factor sign-in for ${account.email}? They will be emailed.`)
    ) {
      return;
    }
    try {
      await apiFetch(token, `/api/ops/accounts/${id}/two-factor`, { method: "DELETE" });
      setAccount({ ...account, twoFactor: false });
    } catch (resetError) {
      setError(
        resetError instanceof Error ? resetError.message : "Two-factor sign-in is still on."
      );
    }
  };

  if (!account) {
    return (
      <div className="p-6 lg:p-8">
        {error ? (
          <p className="text-sm text-destructive-ink">{error}</p>
        ) : (
          <Skeleton className="h-40 w-full rounded-md" />
        )}
      </div>
    );
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "endpoints", label: `Endpoints ${account.endpoints.length}` },
    { value: "billing", label: "Billing" },
    { value: "activity", label: "Activity" },
    { value: "tickets", label: `Tickets ${account.tickets.length}` },
  ];
  const quota =
    account.billing.requestLimit + account.billing.blockRequests > 0
      ? `${count.format(account.billing.requestsUsed)} of ${count.format(account.billing.requestLimit + account.billing.blockRequests)}`
      : "–";
  const firstName = account.name?.trim().split(/\s+/)[0] ?? "this user";

  return (
    <div className="max-w-6xl p-6 lg:p-8">
      <p className="text-xs text-muted-foreground">
        <Link href="/ops/accounts" className="text-primary hover:underline">
          Accounts
        </Link>{" "}
        / {account.email}
      </p>
      <h1 className="ph-no-capture mt-1 text-2xl font-semibold">
        {account.name?.trim() || account.email}
      </h1>
      <p className="ph-no-capture text-sm text-muted-foreground">
        {account.email}, joined {shortDay(account.createdAt)} on{" "}
        {account.homeSite === "mailhooks" ? "mailhooks.cc" : "webhooks.cc"}
        {account.lastSignInAt ? `, signed in ${shortDateTime(account.lastSignInAt)}` : ""}
        {account.staff ? ", staff" : ""}
        {account.internal ? ", internal" : ""}
      </p>

      <div
        role="tablist"
        className="mt-5 flex gap-5 overflow-x-auto border-b border-border text-sm"
      >
        {tabs.map((entry) => (
          <button
            key={entry.value}
            role="tab"
            aria-selected={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={cn(
              "whitespace-nowrap pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === entry.value
                ? "font-medium text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          {(tab === "overview" || tab === "endpoints") && (
            <div className="ui-card ui-card-static p-0! overflow-x-auto">
              {account.endpoints.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No endpoints.</p>
              ) : (
                <table className="w-full text-sm tabular-nums">
                  <thead>
                    <tr className="bg-muted/60 text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Endpoint
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Site
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Captured, 7 days
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Refused
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Failed deliveries
                      </th>
                    </tr>
                  </thead>
                  <tbody className="ph-no-capture">
                    {(tab === "overview" ? account.endpoints.slice(0, 8) : account.endpoints).map(
                      (endpoint) => (
                        <tr key={endpoint.id} className="border-t border-border">
                          <th scope="row" className="px-3 py-2 text-left font-normal">
                            <span className="font-mono text-xs">{endpoint.slug}</span>
                            {endpoint.name && (
                              <span className="ml-2 text-muted-foreground">{endpoint.name}</span>
                            )}
                          </th>
                          <td className="px-3 py-2 text-muted-foreground">{endpoint.site}</td>
                          <td className="px-3 py-2 text-right">
                            {count.format(endpoint.captured7d)}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-2 text-right",
                              endpoint.rejected7d > 0 && "text-destructive-ink"
                            )}
                          >
                            {count.format(endpoint.rejected7d)}
                          </td>
                          <td
                            className={cn(
                              "px-3 py-2 text-right",
                              endpoint.failedDeliveries7d > 0 && "text-destructive-ink"
                            )}
                          >
                            {count.format(endpoint.failedDeliveries7d)}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "overview" && !account.activeGrant && (
            <p className="rounded-md border border-dashed border-input p-3 text-sm text-muted-foreground">
              <b className="text-foreground">Captured requests and emails are locked.</b>{" "}
              {firstName === "this user" ? "The user has" : `${firstName} has`} not given support
              access. Ask on a ticket; the ticket offers a button to give it.
            </p>
          )}

          {tab === "billing" && (
            <dl className="ui-card ui-card-static grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Plan</dt>
              <dd>
                {planName(account.plan)}
                {account.billing.interval
                  ? `, ${account.billing.interval === "year" ? "annual" : "monthly"}`
                  : ""}
                {account.staff ? " (staff, no subscription)" : ""}
              </dd>
              <dt className="text-muted-foreground">Subscription</dt>
              <dd>{account.billing.subscriptionStatus ?? "None"}</dd>
              <dt className="text-muted-foreground">Quota period ends</dt>
              <dd>{account.billing.periodEnd ? shortDateTime(account.billing.periodEnd) : "–"}</dd>
              <dt className="text-muted-foreground">Billing period ends</dt>
              <dd>
                {account.billing.billingPeriodEnd
                  ? shortDateTime(account.billing.billingPeriodEnd)
                  : "–"}
              </dd>
              <dt className="text-muted-foreground">Ends at period end</dt>
              <dd>{account.billing.cancelAtPeriodEnd ? "Yes" : "No"}</dd>
              <dt className="text-muted-foreground">Pending plan</dt>
              <dd>{account.billing.pendingPlan ?? "None"}</dd>
              <dt className="text-muted-foreground">Requests</dt>
              <dd className="tabular-nums">{quota}</dd>
              <dt className="text-muted-foreground">Overage</dt>
              <dd>{account.billing.overageActive ? "On" : "Off"}</dd>
            </dl>
          )}

          {tab === "activity" && (
            <ul className="ui-card ui-card-static p-0! overflow-hidden text-sm">
              {account.activity.length === 0 ? (
                <li className="p-4 text-muted-foreground">No recorded actions.</li>
              ) : (
                account.activity.map((entry, index) => (
                  <li
                    key={index}
                    className="flex justify-between gap-4 border-t border-border px-4 py-2 first:border-t-0"
                  >
                    <span className="font-mono text-xs">
                      {entry.action}
                      {entry.outcome !== "ok" && (
                        <span className="ml-2 text-destructive-ink">{entry.outcome}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.via ? `${entry.via.replace("_", " ")}, ` : ""}
                      {shortDateTime(entry.at)}
                    </span>
                  </li>
                ))
              )}
            </ul>
          )}

          {tab === "tickets" && (
            <ul className="ui-card ui-card-static p-0! overflow-hidden text-sm ph-no-capture">
              {account.tickets.length === 0 ? (
                <li className="p-4 text-muted-foreground">No tickets.</li>
              ) : (
                account.tickets.map((ticket) => (
                  <li key={ticket.id} className="border-t border-border first:border-t-0">
                    <Link
                      href={`/ops/tickets/${ticket.number}`}
                      className="flex justify-between gap-4 px-4 py-2 hover:bg-muted/60"
                    >
                      <span className="truncate">
                        <span className="font-mono text-xs text-muted-foreground">
                          #{ticket.number}
                        </span>{" "}
                        {ticket.subject}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {ticket.status}
                      </span>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        <aside className="space-y-4">
          <dl className="ui-card ui-card-static grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{planName(account.plan)}</dd>
            <dt className="text-muted-foreground">Requests</dt>
            <dd className="tabular-nums">{quota}</dd>
            <dt className="text-muted-foreground">Teams</dt>
            <dd>
              {account.teams.length === 0
                ? "None"
                : account.teams.map((team) => `${team.name} (${team.role})`).join(", ")}
            </dd>
            <dt className="text-muted-foreground">API keys</dt>
            <dd>{account.apiKeys}</dd>
            <dt className="text-muted-foreground">Agents</dt>
            <dd>{account.agents}</dd>
            <dt className="text-muted-foreground">Two-factor</dt>
            <dd>{account.twoFactor ? "On" : "Off"}</dd>
          </dl>
          {account.twoFactor && !account.staff && (
            <div className="ui-card ui-card-static space-y-2 text-sm">
              <h2 className="font-semibold">Lost authenticator</h2>
              <p className="text-muted-foreground">
                Only after they proved who they are, for example by writing from the account&rsquo;s
                address. This removes their authenticator and recovery codes and emails them.
              </p>
              <Button size="sm" variant="outline" onClick={() => void resetTwoFactor()}>
                Turn off two-factor sign-in
              </Button>
            </div>
          )}
          <div className="ui-card ui-card-static space-y-2 text-sm">
            <h2 className="font-semibold">View as {firstName}</h2>
            {account.activeGrant ? (
              <>
                <p className="text-muted-foreground">
                  Access given on ticket{" "}
                  <span className="font-mono">#{account.activeGrant.number}</span>.
                </p>
                <Button
                  size="sm"
                  render={<Link href={`/ops/tickets/${account.activeGrant.number}`} />}
                >
                  Open from the ticket
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground">
                Available once {firstName} gives access on a ticket.
              </p>
            )}
          </div>
          <div className="ui-card ui-card-static space-y-2 text-sm">
            <h2 className="font-semibold">Metrics</h2>
            <p className="text-muted-foreground">
              {account.internal
                ? "Marked internal: left out of the ops metrics."
                : "Counted in the ops metrics. Mark test accounts internal."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={account.staff}
              onClick={() => void toggleInternal()}
            >
              {account.internal ? "Count it again" : "Mark internal"}
            </Button>
          </div>
          <AccountSharingPanel userId={id} />
          {error && <p className="text-sm text-destructive-ink">{error}</p>}
        </aside>
      </div>
    </div>
  );
}
