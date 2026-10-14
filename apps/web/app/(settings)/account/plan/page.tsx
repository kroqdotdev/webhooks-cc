"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ManageSubscriptionDialog } from "@/components/billing/manage-subscription-dialog";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import { UpgradeButton } from "@/components/billing/upgrade-button";
import {
  Notice,
  Panel,
  SettingsPageHeader,
  SettingsPageSkeleton,
} from "@/components/settings/panel";
import { QuotaMeter } from "@/components/settings/quota-meter";
import { useSettingsData } from "@/components/settings/settings-data";
import { useAccountProfile } from "@/components/settings/use-account-profile";
import { Button } from "@/components/ui/button";
import { trackUpgradeCompleted } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { longDate } from "@/components/settings/format";

function ResetCountdown({ periodEnd }: { periodEnd: string }) {
  const [text, setText] = useState("");

  useEffect(() => {
    const update = () => {
      const remaining = new Date(periodEnd).getTime() - Date.now();
      if (remaining <= 0) {
        setText("A new 24-hour window starts with your next request");
        return;
      }
      if (remaining < 60_000) {
        setText("Resets in under a minute");
        return;
      }
      const hours = Math.floor(remaining / 3_600_000);
      const minutes = Math.floor((remaining % 3_600_000) / 60_000);
      setText(`Resets in ${hours}h ${minutes}m`);
    };
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [periodEnd]);

  return <>{text}</>;
}

function UpgradeSuccessNotice() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (searchParams.get("upgraded") === "true") {
      setShow(true);
      trackUpgradeCompleted();
      router.replace("/account/plan", { scroll: false });
    }
  }, [searchParams, router]);

  if (!show) return null;

  return (
    <Notice
      tone="success"
      title="Welcome to Pro"
      action={
        <Button variant="ghost" size="sm" onClick={() => setShow(false)}>
          Dismiss
        </Button>
      }
    >
      Your subscription is active: 100,000 requests every 30 days, kept for 31 days.
    </Notice>
  );
}

const PLAN_ROWS: { label: string; free: string; pro: string }[] = [
  { label: "Requests", free: "50 a day", pro: "100,000 per 30 days" },
  { label: "Requests kept for", free: "7 days", pro: "31 days" },
  { label: "Price", free: "Free", pro: "$8 a month" },
];

function PlanTable({ current }: { current: "free" | "pro" }) {
  const column = (plan: "free" | "pro") =>
    cn("px-4 py-3 text-left", current === plan && "bg-muted/60 font-medium");
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Free and Pro plans compared</caption>
      <thead>
        <tr className="border-b-strong border-line">
          <th scope="col" className="px-5 py-3 text-left font-medium text-muted-foreground">
            <span className="sr-only">Feature</span>
          </th>
          <th scope="col" className={column("free")}>
            Free
            {current === "free" && (
              <span className="font-normal text-muted-foreground"> (your plan)</span>
            )}
          </th>
          <th scope="col" className={column("pro")}>
            Pro
            {current === "pro" && (
              <span className="font-normal text-muted-foreground"> (your plan)</span>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        {PLAN_ROWS.map((row) => (
          <tr key={row.label} className="border-b border-line/60 last:border-b-0">
            <th scope="row" className="px-5 py-3 text-left font-normal text-muted-foreground">
              {row.label}
            </th>
            <td className={column("free")}>{row.free}</td>
            <td className={column("pro")}>{row.pro}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PlanPage() {
  const { profile, periodEmails, loading, refresh, accessToken } = useAccountProfile({
    live: true,
  });
  const { teams } = useSettingsData();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <SettingsPageSkeleton label="Loading your plan" panels={3} />;
  }

  if (!profile) {
    return (
      <p className="text-sm text-muted-foreground">
        Your plan could not be loaded. Refresh the page to try again.
      </p>
    );
  }

  const isFree = profile.plan === "free";
  const periodEndMs = profile.period_end ? Date.parse(profile.period_end) : NaN;
  // A lapsed free window resets lazily on the next capture; show it as empty.
  const freePeriodExpired = isFree && Number.isFinite(periodEndMs) && periodEndMs <= nowMs;
  const used = freePeriodExpired ? 0 : profile.requests_used;
  const emails = freePeriodExpired ? 0 : Math.min(periodEmails ?? 0, used);
  const activeTeams = teams.filter((team) => !team.suspended);

  const caption = profile.period_end ? (
    isFree ? (
      <ResetCountdown periodEnd={profile.period_end} />
    ) : (
      `Resets ${longDate(profile.period_end)}`
    )
  ) : isFree ? (
    "Your 24-hour window starts with your next request"
  ) : null;

  return (
    <>
      <SettingsPageHeader
        title="Plan and usage"
        description="What your account can capture, and how much of it you have used."
      />

      <div className="space-y-6">
        <Suspense fallback={null}>
          <UpgradeSuccessNotice />
        </Suspense>
        <PastDueBanner subscriptionStatus={profile.subscription_status} />

        <Panel
          id="usage"
          title={isFree ? "Requests today" : "Requests this period"}
          description="HTTP requests and emails both count. Requests to endpoints shared with an active team count against that team instead."
        >
          <QuotaMeter used={used} limit={profile.request_limit} emails={emails} caption={caption} />
        </Panel>

        <Panel
          id="plan"
          title="Your plan"
          flush
          footer={
            isFree ? (
              <UpgradeButton accessToken={accessToken} />
            ) : (
              <>
                <ManageSubscriptionDialog
                  accessToken={accessToken}
                  profile={profile}
                  onUpdated={refresh}
                />
                {profile.period_end && !profile.cancel_at_period_end && (
                  <p className="text-sm text-muted-foreground">
                    Next payment on {longDate(profile.period_end)}
                  </p>
                )}
              </>
            )
          }
        >
          {!isFree && profile.cancel_at_period_end && profile.period_end && (
            <div className="px-5 pt-4">
              <Notice tone="warning" title={`Pro ends on ${longDate(profile.period_end)}`}>
                After that your account moves to the free plan. Keep your subscription from Manage
                subscription.
              </Notice>
            </div>
          )}
          <PlanTable current={isFree ? "free" : "pro"} />
        </Panel>

        {activeTeams.length > 0 && (
          <Panel
            id="team-pools"
            title="Team pools"
            description="Endpoints you share with these teams draw from the team's requests, not yours."
            flush
          >
            <ul>
              {activeTeams.map((team) => (
                <li
                  key={team.id}
                  className="grid gap-3 border-b border-line/60 px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-center sm:gap-6"
                >
                  <Link
                    href={`/teams/${team.id}`}
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {team.name}
                  </Link>
                  <div className="space-y-1">
                    <QuotaMeter
                      used={team.requestsUsed}
                      limit={team.requestLimit}
                      seats={Array.from({ length: Math.min(team.seats, 40) }, () => ({
                        kind: "open" as const,
                      }))}
                      compact
                    />
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {team.requestsUsed.toLocaleString()} of {team.requestLimit.toLocaleString()}{" "}
                      requests
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}
