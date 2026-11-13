import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCapacityState,
  type CapacityAccount,
  type CapacityResource,
  type CapacityState,
} from "@/lib/supabase/capacity-billing";
import { listTeamsForUser } from "@/lib/supabase/teams-crud";
import type { Team } from "@/lib/supabase/teams-types";

/**
 * What an account pays for, readable with an API key (GET /api/billing): the
 * plan and its subscription, the add-ons (extra requests, parsed pages and
 * domains) and, for every team the account belongs to, the team's
 * subscription and add-ons. Reads only our own tables, never Polar.
 *
 * Changing any of it (a plan, seats, add-ons) still takes a browser session:
 * payments stay with a person.
 */
export interface BillingSummary {
  plan: "free" | "pro" | "business";
  /** The plan's subscription; null on Free. */
  subscription: {
    status: "active" | "canceled" | "past_due" | null;
    interval: "month" | "year" | null;
    /** When the subscription renews (or ends, with cancelAtPeriodEnd). */
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
    /** A change waiting for the renewal (a downgrade, or monthly to annual). */
    pendingChange: { plan: string; interval: "month" | "year" | null } | null;
  } | null;
  /** The quota period the request counts follow (a month, on annual billing too). */
  quotaPeriod: { start: string | null; end: string | null };
  addons: Record<CapacityResource, CapacityState>;
  teams: (Team & { addons: Record<CapacityResource, CapacityState> })[];
}

const RESOURCES: CapacityResource[] = ["requests", "pages", "domains"];

async function addonsOf(
  account: CapacityAccount
): Promise<Record<CapacityResource, CapacityState>> {
  const states = await Promise.all(RESOURCES.map((r) => getCapacityState(account, r)));
  return Object.fromEntries(RESOURCES.map((r, i) => [r, states[i]])) as Record<
    CapacityResource,
    CapacityState
  >;
}

function iso(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function getBillingSummary(userId: string): Promise<BillingSummary | null> {
  const { data: user, error } = await createAdminClient()
    .from("users")
    .select(
      "plan, subscription_status, billing_interval, billing_period_end, cancel_at_period_end, pending_plan, pending_interval, period_start, period_end, polar_subscription_id"
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) return null;

  const [addons, teams] = await Promise.all([
    addonsOf({ kind: "user", userId }),
    listTeamsForUser(userId),
  ]);
  const teamAddons = await Promise.all(teams.map((t) => addonsOf({ kind: "team", teamId: t.id })));

  const subscribed = user.polar_subscription_id !== null || user.subscription_status !== null;
  return {
    plan: (user.plan ?? "free") as BillingSummary["plan"],
    subscription: subscribed
      ? {
          status: user.subscription_status,
          interval: user.billing_interval,
          renewsAt: iso(user.billing_period_end),
          cancelAtPeriodEnd: Boolean(user.cancel_at_period_end),
          pendingChange: user.pending_plan
            ? {
                plan: user.pending_plan,
                interval:
                  user.pending_interval === "month" || user.pending_interval === "year"
                    ? user.pending_interval
                    : null,
              }
            : null,
        }
      : null,
    quotaPeriod: { start: iso(user.period_start), end: iso(user.period_end) },
    addons,
    teams: teams.map((team, i) => ({ ...team, addons: teamAddons[i] })),
  };
}
