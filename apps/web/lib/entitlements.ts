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
  /** Team keys: parsed pages and AI assists are per seat too (requests always are). */
  perSeat: boolean;
  /** Live `whk share` previews at once (per member on team keys). */
  shareSlots: number;
  /** How long one preview may run; null for as long as the CLI does. */
  shareSessionMinutes: number | null;
  /** What visitors may take from the account's previews a UTC month, in GB. */
  shareDataGb: number;
  /** Preview names the account may keep (random names only at 0). */
  reservedNames: number;
  /** Passwords on preview links. */
  sharePasswords: boolean;
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
    perSeat: false,
    shareSlots: 1,
    shareSessionMinutes: 120,
    shareDataGb: 1,
    reservedNames: 0,
    sharePasswords: false,
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
    perSeat: false,
    shareSlots: 3,
    shareSessionMinutes: null,
    shareDataGb: 25,
    reservedNames: 3,
    sharePasswords: true,
  },
  business: {
    key: "business",
    requestLimit: 250_000,
    poolRequests: 0,
    quotaPeriod: "month",
    retentionDays: 90,
    parsedPages: 2_000,
    layoutsPerEndpoint: 50,
    aiAssists: 250,
    customDomains: 1,
    fileDrops: true,
    requestAddons: true,
    pageAddons: true,
    annualBilling: true,
    perSeat: false,
    shareSlots: 10,
    shareSessionMinutes: null,
    shareDataGb: 150,
    reservedNames: 20,
    sharePasswords: true,
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
    perSeat: false,
    shareSlots: 3,
    shareSessionMinutes: null,
    shareDataGb: 25,
    reservedNames: 3,
    sharePasswords: true,
  },
  team_business: {
    key: "team_business",
    requestLimit: 250_000,
    poolRequests: 0,
    quotaPeriod: "month",
    retentionDays: 90,
    parsedPages: 2_000,
    layoutsPerEndpoint: 50,
    aiAssists: 250,
    customDomains: 1,
    fileDrops: true,
    requestAddons: true,
    pageAddons: true,
    annualBilling: true,
    perSeat: true,
    shareSlots: 10,
    shareSessionMinutes: null,
    shareDataGb: 150,
    reservedNames: 20,
    sharePasswords: true,
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

/** A subscribed team's entitlements: Team Business or Teams. */
export function teamEntitlements(business: boolean): Readonly<Entitlements> {
  return business ? ENTITLEMENTS.team_business : ENTITLEMENTS.team;
}

/** What a team gets for its seats in a quota period: requests, parsed pages and AI assists. */
export function teamAllowance(
  seats: number,
  business: boolean
): { requests: number; parsedPages: number; aiAssists: number } {
  const e = teamEntitlements(business);
  const count = Math.max(0, Math.floor(seats));
  // The database counts at least one seat for pages and assists.
  const scale = e.perSeat ? Math.max(1, count) : 1;
  return {
    requests: count * e.requestLimit + e.poolRequests,
    parsedPages: e.parsedPages * scale,
    aiAssists: e.aiAssists * scale,
  };
}

/** A team's pooled request allowance for `seats` seats. */
export function teamRequestLimit(seats: number, business: boolean): number {
  return teamAllowance(seats, business).requests;
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
