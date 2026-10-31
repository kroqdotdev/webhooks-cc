import type { PlanKey } from "@/lib/supabase/database";

/**
 * What each plan includes: the one map of limits and features. The database
 * holds the same rows in `plan_entitlements` (migration 00067), which the SQL
 * functions read; an integration test compares the two, so change them
 * together. Pages, layouts, AI assists and domains are per month and per
 * account (pooled for teams) unless the name says otherwise.
 */

/** A personal plan: what `users.plan` holds. */
export type UserPlan = "free" | "pro" | "business";
export type { PlanKey };

export interface Entitlements {
  key: PlanKey;
  /** Requests per quota period; for team keys, per seat. */
  requestLimit: number;
  /** Requests added to a team's pool on top of its seats. */
  poolRequests: number;
  /** "day": the lazy 24-hour period free accounts have. */
  quotaPeriod: "day" | "month";
  retentionDays: number;
  parsedPages: number;
  layoutsPerEndpoint: number;
  aiAssists: number;
  customDomains: number;
  fileDrops: boolean;
  /** Request blocks and request overage. */
  requestAddons: boolean;
  /** Page blocks and page overage. */
  pageAddons: boolean;
  annualBilling: boolean;
}

export const ENTITLEMENTS: Readonly<Record<PlanKey, Readonly<Entitlements>>> = {
  free: {
    key: "free",
    requestLimit: 50,
    poolRequests: 0,
    quotaPeriod: "day",
    retentionDays: 7,
    parsedPages: 20,
    layoutsPerEndpoint: 2,
    aiAssists: 5,
    customDomains: 0,
    fileDrops: false,
    requestAddons: false,
    pageAddons: false,
    annualBilling: false,
  },
  pro: {
    key: "pro",
    requestLimit: 100_000,
    poolRequests: 0,
    quotaPeriod: "month",
    retentionDays: 31,
    parsedPages: 100,
    layoutsPerEndpoint: 2,
    aiAssists: 20,
    customDomains: 0,
    fileDrops: false,
    requestAddons: true,
    pageAddons: false,
    annualBilling: false,
  },
  business: {
    key: "business",
    requestLimit: 250_000,
    poolRequests: 0,
    quotaPeriod: "month",
    retentionDays: 90,
    parsedPages: 2_000,
    layoutsPerEndpoint: 50,
    aiAssists: 500,
    customDomains: 1,
    fileDrops: true,
    requestAddons: true,
    pageAddons: true,
    annualBilling: true,
  },
  team: {
    key: "team",
    requestLimit: 100_000,
    poolRequests: 0,
    quotaPeriod: "month",
    retentionDays: 31,
    parsedPages: 100,
    layoutsPerEndpoint: 2,
    aiAssists: 20,
    customDomains: 0,
    fileDrops: false,
    requestAddons: true,
    pageAddons: false,
    annualBilling: false,
  },
  team_business: {
    key: "team_business",
    requestLimit: 100_000,
    poolRequests: 150_000,
    quotaPeriod: "month",
    retentionDays: 90,
    parsedPages: 2_000,
    layoutsPerEndpoint: 50,
    aiAssists: 500,
    customDomains: 1,
    fileDrops: true,
    requestAddons: true,
    pageAddons: true,
    annualBilling: false,
  },
};

export const USER_PLANS: readonly UserPlan[] = ["free", "pro", "business"];

export function isUserPlan(value: unknown): value is UserPlan {
  return typeof value === "string" && (USER_PLANS as readonly string[]).includes(value);
}

/** A personal plan's entitlements; anything unknown reads as free. */
export function planEntitlements(plan: string | null | undefined): Readonly<Entitlements> {
  return isUserPlan(plan) ? ENTITLEMENTS[plan] : ENTITLEMENTS.free;
}

/** A subscribed team's entitlements: with the Business add-on or without. */
export function teamEntitlements(business: boolean): Readonly<Entitlements> {
  return business ? ENTITLEMENTS.team_business : ENTITLEMENTS.team;
}

/** A team's pooled request allowance for `seats` seats. */
export function teamRequestLimit(seats: number, business: boolean): number {
  const e = teamEntitlements(business);
  return Math.max(0, Math.floor(seats)) * e.requestLimit + e.poolRequests;
}

/** The name shown for a personal plan. */
export function planName(plan: string | null | undefined): string {
  switch (plan) {
    case "business":
      return "Business";
    case "pro":
      return "Pro";
    default:
      return "Free";
  }
}

/** True for a plan someone pays for. */
export function isPaidPlan(plan: string | null | undefined): boolean {
  return plan === "pro" || plan === "business";
}

/**
 * Days a request is kept: the plan's retention, or a longer grace kept for a
 * week after a downgrade (users.retention_floor_days until
 * retention_floor_until).
 */
export function retentionDays(
  plan: string | null | undefined,
  floor?: { days: number | null; until: string | null } | null,
  now = Date.now()
): number {
  const days = planEntitlements(plan).retentionDays;
  if (floor?.days && floor.until && Date.parse(floor.until) > now) {
    return Math.max(days, floor.days);
  }
  return days;
}
