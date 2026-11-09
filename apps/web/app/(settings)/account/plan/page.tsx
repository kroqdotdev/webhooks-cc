"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CapacityPanel } from "@/components/billing/capacity-panel";
import { BillingPortalButton } from "@/components/billing/billing-portal";
import { ManageSubscriptionDialog } from "@/components/billing/manage-subscription-dialog";
import { ParsedPagesPanel } from "@/components/billing/parsed-pages-panel";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import {
  PlanActions,
  PlanChooserStatus,
  usePlanChooser,
  type PlanChooserState,
} from "@/components/billing/plan-chooser";
import { Segmented } from "@/components/dashboard/settings-primitives";
import type { AccountProfile } from "@/lib/account-profile";
import { planName } from "@/lib/billing-api";
import {
  Notice,
  Panel,
  SettingsPageHeader,
  SettingsPageSkeleton,
} from "@/components/settings/panel";
import { QuotaMeter } from "@/components/settings/quota-meter";
import { useSettingsData } from "@/components/settings/settings-data";
import { useAccountProfile } from "@/components/settings/use-account-profile";
import { useStaff } from "@/components/ops/use-staff";
import { Button } from "@/components/ui/button";
import { trackUpgradeCompleted } from "@/lib/analytics";
import { planEntitlements } from "@/lib/entitlements";
import { cn } from "@/lib/utils";
import { longDate } from "@/components/settings/format";
import { useSite } from "@/components/providers/site-provider";

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
  const [show, setShow] = useState<"pro" | "business" | null>(null);

  useEffect(() => {
    const upgraded = searchParams.get("upgraded");
    if (upgraded === "true" || upgraded === "pro" || upgraded === "business") {
      setShow(upgraded === "business" ? "business" : "pro");
      trackUpgradeCompleted();
      router.replace("/account/plan", { scroll: false });
    }
  }, [searchParams, router]);

  if (!show) return null;

  return (
    <Notice
      tone="success"
      title={`Welcome to ${planName(show)}`}
      action={
        <Button variant="ghost" size="sm" onClick={() => setShow(null)}>
          Dismiss
        </Button>
      }
    >
      {show === "business"
        ? "Your subscription is active: 250,000 requests and 2,000 parsed pages a month, kept for 90 days, up to 50 layouts per endpoint, a custom inbound domain and file drops."
        : "Your subscription is active: 100,000 requests a month, kept for 31 days."}
    </Notice>
  );
}

type PlanKey = "free" | "pro" | "business";

const PLAN_ROWS: { label: string; free: string; pro: string; business: string }[] = [
  { label: "Requests", free: "50 a day", pro: "100,000 a month", business: "250,000 a month" },
  { label: "Requests kept for", free: "7 days", pro: "31 days", business: "90 days" },
  {
    label: "Parsed attachment pages",
    free: "20 a month",
    pro: "100 a month",
    business: "2,000 a month, then blocks or overage",
  },
  { label: "Layouts per endpoint", free: "2", pro: "2", business: "Up to 50" },
  {
    label: "AI assists",
    free: "5 every 30 days",
    pro: "20 every 30 days",
    business: "250 every 30 days",
  },
  {
    label: "Custom inbound domains",
    free: "None",
    pro: "None",
    business: "1, then $3 a month each",
  },
  { label: "File drops (SFTP, FTP, S3)", free: "No", pro: "No", business: "Yes" },
  {
    label: "Price",
    free: "Free",
    pro: "$8 a month",
    business: "$29 a month, or $290 a year",
  },
];

/** mailhooks.cc names the shared quota in the words of mail first. */
const MAIL_ROW_LABELS: Record<string, string> = {
  Requests: "Emails and webhooks",
  "Requests kept for": "Kept for",
};

const PLANS: PlanKey[] = ["free", "pro", "business"];

function PlanTable({ current, chooser }: { current: PlanKey; chooser: PlanChooserState | null }) {
  const mailFirst = useSite().key === "mailhooks";
  const column = (plan: PlanKey) =>
    cn("px-4 py-3 text-left align-top", current === plan && "bg-muted/60 font-medium");
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Free, Pro and Business plans compared</caption>
      <thead>
        <tr className="border-b-strong border-line">
          <th scope="col" className="px-5 py-3 text-left font-medium text-muted-foreground">
            <span className="sr-only">Feature</span>
          </th>
          {PLANS.map((plan) => (
            <th key={plan} scope="col" className={column(plan)}>
              {planName(plan)}
              {current === plan && (
                <span className="font-normal text-muted-foreground"> (your plan)</span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {PLAN_ROWS.map((row) => (
          <tr key={row.label} className="border-b border-line/60">
            <th scope="row" className="px-5 py-3 text-left font-normal text-muted-foreground">
              {(mailFirst && MAIL_ROW_LABELS[row.label]) || row.label}
            </th>
            {PLANS.map((plan) => (
              <td key={plan} className={column(plan)}>
                {row[plan]}
              </td>
            ))}
          </tr>
        ))}
        {/* Each plan's change sits under its own column. */}
        <tr>
          <th scope="row" className="px-5 py-3 text-left font-normal">
            <span className="sr-only">Change plan</span>
          </th>
          {PLANS.map((plan) => (
            <td key={plan} className={column(plan)}>
              <PlanActions chooser={chooser} plan={plan} current={current} />
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/** Phones: one plan at a time, picked above, instead of a table that scrolls sideways. */
function PlanList({ current, chooser }: { current: PlanKey; chooser: PlanChooserState | null }) {
  const mailFirst = useSite().key === "mailhooks";
  const [shown, setShown] = useState<PlanKey>(current);
  return (
    <div className="space-y-4 px-5 py-4">
      <Segmented
        name="Plan"
        value={shown}
        onChange={setShown}
        options={PLANS.map((plan) => ({
          value: plan,
          label: planName(plan),
        }))}
      />
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 text-sm">
        {PLAN_ROWS.map((row) => (
          <div
            key={row.label}
            className="col-span-2 grid grid-cols-subgrid border-b border-line/60 py-2"
          >
            <dt className="text-muted-foreground">
              {(mailFirst && MAIL_ROW_LABELS[row.label]) || row.label}
            </dt>
            <dd>{row[shown]}</dd>
          </div>
        ))}
      </dl>
      <PlanActions chooser={chooser} plan={shown} current={current} />
    </div>
  );
}

/** The plans side by side, with each change under the plan it leads to. */
function YourPlanPanel({
  profile,
  accessToken,
  refresh,
  comped,
  currentPlan,
  billingEnd,
}: {
  profile: AccountProfile;
  accessToken: string | null;
  refresh: () => Promise<void> | void;
  comped: boolean;
  currentPlan: PlanKey;
  billingEnd: string | null;
}) {
  const chooser = usePlanChooser({ accessToken, profile, onChanged: refresh });
  const isFree = profile.plan === "free";
  // A free account's choice leaves for the checkout at once: only a failure needs a line here.
  const showStatus = !isFree || !!chooser.error;
  return (
    <Panel
      id="plan"
      title="Your plan"
      flush
      footer={
        comped || !showStatus ? undefined : (
          <div className="w-full space-y-3">
            <PlanChooserStatus chooser={chooser} />
            {!isFree && (
              <div className="flex flex-wrap items-center gap-3">
                <ManageSubscriptionDialog
                  accessToken={accessToken}
                  profile={profile}
                  onUpdated={refresh}
                />
                <BillingPortalButton accessToken={accessToken} />
                {billingEnd && !profile.cancel_at_period_end && (
                  <p className="text-sm text-muted-foreground">
                    Next payment on {longDate(billingEnd)}
                  </p>
                )}
              </div>
            )}
          </div>
        )
      }
    >
      {!isFree && profile.cancel_at_period_end && billingEnd && (
        <div className="px-5 pt-4">
          <Notice
            tone="warning"
            title={`${planName(profile.plan)} ends on ${longDate(billingEnd)}`}
          >
            After that your account moves to the free plan. Keep your subscription from Manage
            subscription.
          </Notice>
        </div>
      )}
      <div className="max-md:hidden overflow-x-auto">
        <PlanTable current={currentPlan} chooser={comped ? null : chooser} />
      </div>
      <div className="md:hidden">
        <PlanList current={currentPlan} chooser={comped ? null : chooser} />
      </div>
    </Panel>
  );
}

export default function PlanPage() {
  const { profile, periodEmails, loading, refresh, accessToken } = useAccountProfile({
    live: true,
  });
  const { teams } = useSettingsData();
  // mailhooks.cc counts the same quota in the words of mail first.
  const mailFirst = useSite().key === "mailhooks";
  const counted = mailFirst ? "emails and webhooks" : "requests";
  // A paid plan without a subscription may be a staff account's (migration
  // 00087); ask only then, so other accounts never make the request.
  const staff = useStaff(
    profile?.id ?? null,
    accessToken,
    !!profile && profile.plan !== "free" && !profile.polar_subscription_id
  );
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
  const allowance = profile.request_limit + profile.block_requests;
  const activeTeams = teams.filter((team) => !team.suspended);
  const currentPlan: PlanKey =
    profile.plan === "business" ? "business" : profile.plan === "pro" ? "pro" : "free";
  // An annual plan's quota renews monthly; its payment comes with the year.
  const billingEnd = profile.billing_period_end ?? profile.period_end;
  // A paid plan without a subscription is a staff account's (migration 00087):
  // nothing to buy, change or cancel.
  const comped = staff?.staff === true && !isFree && !profile.polar_subscription_id;

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
        <PastDueBanner
          subscriptionStatus={profile.subscription_status}
          plan={profile.plan}
          accessToken={accessToken}
        />
        <RetentionGraceNotice profile={profile} />

        <Panel
          id="usage"
          title={
            mailFirst
              ? isFree
                ? "Emails and webhooks today"
                : "Emails and webhooks this period"
              : isFree
                ? "Requests today"
                : "Requests this period"
          }
          description={
            mailFirst
              ? "Emails and HTTP requests both count. Those to endpoints shared with an active team count against that team instead."
              : "HTTP requests and emails both count. Requests to endpoints shared with an active team count against that team instead."
          }
        >
          <QuotaMeter
            used={used}
            limit={allowance}
            emails={emails}
            caption={caption}
            label={counted}
          />
          {profile.block_requests > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Includes {profile.block_requests.toLocaleString()} from monthly blocks.
            </p>
          )}
        </Panel>

        {comped && (
          <Notice tone="success" title={`${planName(profile.plan)} through a staff account`}>
            This account has {planName(profile.plan)} without a subscription. There is nothing to
            pay, change or cancel here.
          </Notice>
        )}

        {!comped && (
          <CapacityPanel
            accessToken={accessToken}
            canManage
            onChanged={refresh}
            reloadKey={[
              profile.plan,
              profile.subscription_status,
              profile.cancel_at_period_end,
              profile.period_end,
              profile.block_requests,
              profile.credit_requests > 0,
              profile.overage_active,
              profile.overage_max,
            ].join(":")}
          />
        )}

        <YourPlanPanel
          profile={profile}
          accessToken={accessToken}
          refresh={refresh}
          comped={comped}
          currentPlan={currentPlan}
          billingEnd={billingEnd}
        />

        <ParsedPagesPanel
          accessToken={accessToken}
          canManage
          reloadKey={[
            profile.plan,
            profile.subscription_status,
            profile.period_end,
            profile.cancel_at_period_end,
            profile.pending_plan,
          ].join(":")}
        />

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
                      {counted}
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

/**
 * After a move to a plan with shorter retention, requests are kept as long
 * as before for a week (retention_floor_until); this says when the plan's
 * own days take over and older requests are deleted.
 */
function RetentionGraceNotice({
  profile,
}: {
  profile: {
    plan: string;
    retention_floor_days: number | null;
    retention_floor_until: string | null;
  };
}) {
  const [nowMs] = useState(() => Date.now());
  const until = profile.retention_floor_until;
  const days = profile.retention_floor_days;
  const planDays = planEntitlements(profile.plan).retentionDays;
  if (!until || !days || days <= planDays || Date.parse(until) <= nowMs) return null;
  return (
    <Notice tone="warning" title={`Requests are kept ${days} days until ${longDate(until)}`}>
      After that, {planName(profile.plan)} keeps them for {planDays} days, and older requests are
      deleted. Export anything you need before then.
    </Notice>
  );
}
