import {
  BLOCK_PAGES,
  BLOCK_REQUESTS,
  DEFAULT_OVERAGE_MAX_REQUESTS,
  DEFAULT_PAGE_OVERAGE_MAX_PAGES,
  MAX_BLOCKS,
  MAX_EXTRA_DOMAINS,
  MAX_PAGE_BLOCKS,
  periodOverageUsed,
} from "@/lib/capacity";
import { publicEnv } from "@/lib/env";
import {
  configuredCapacityProductIds,
  configuredDomainProductIds,
  configuredPageProductIds,
  createPolarClient,
  getCapacityProductIds,
  getDomainProductIds,
  getPageProductIds,
  isEndedSubscriptionError,
  loggablePolarError,
  type CapacityProductIds,
} from "@/lib/polar";
import { currentPolarMutationGuard } from "@/lib/billing/polar-guard";
import { recordRefund, type RefundTarget } from "@/lib/billing/refunds";
import { reportError } from "@/lib/observability";
import { planEntitlements, teamAllowance, teamEntitlements } from "@/lib/entitlements";
import { createAdminClient } from "./admin";
import { addMonthUtc, ensurePolarCustomerId, getBillingUser } from "./billing";
import { returnOrigin } from "@/lib/site-server";
import {
  asNonEmptyString,
  asRecord,
  checkoutSession,
  CHECKOUT_LINK_METADATA_KEY,
  parseEventTimestamp,
  type CheckoutLinkContext,
  type CheckoutSession,
  type LinkPurchase,
} from "./billing-shared";
import type { Database } from "./database";
import { ensureTeamPolarCustomerId, getTeamForOwner } from "./team-billing";
import {
  checkoutLinkOverageMax,
  markCheckoutLinkMismatch,
  supersedeCheckoutLinks,
} from "@/lib/billing/checkout-link-rows";

/**
 * Extra request capacity in Polar (migration 00065), for a Pro account and a
 * team pool alike:
 *
 * - Recurring blocks are a unit-priced monthly subscription whose billing
 *   period is moved onto the plan's, so both renew together. Adding blocks
 *   mid-period is a one-time order at the full monthly price (Polar's own
 *   proration would charge a share); the subscription's count is then raised
 *   from the next renewal ("next_period"). Removing blocks also waits for the
 *   renewal.
 * - One-time blocks are unit-priced one-time orders.
 * - Overage is a subscription with only a metered price, aligned the same
 *   way. Captures count it against a maximum the customer sets per plan
 *   period, and the reporter (lib/billing/overage-reporter.ts) sends the
 *   count to Polar's meter, which bills it at the end of the period.
 *
 * Parsed pages (migration 00070) are bought the same three ways, for
 * Business accounts and Team Business teams (the team plan's own product
 * since migration 00083): the same functions with `resource: "pages"`.
 *
 * Extra inbound domains (migration 00073) are recurring blocks only, one
 * unit per domain, with the same mid-period add: `resource: "domains"`.
 * Like page add-ons they need Business or Team Business.
 *
 * Polar's subscription events for these products never reach the plan
 * handlers: the webhook routes them here by product.
 */

export type CapacityAccount = { kind: "user"; userId: string } | { kind: "team"; teamId: string };

type CapacitySubscriptionRow = Database["public"]["Tables"]["capacity_subscriptions"]["Row"];
type CapacityKind = CapacitySubscriptionRow["kind"];

type PurchaseKind = Database["public"]["Tables"]["capacity_purchases"]["Row"]["kind"];

/** What an add-on adds to: the request quota, the parsed pages or the custom domains. */
export type CapacityResource = "requests" | "pages" | "domains";

/** A resource's products: every resource has recurring blocks, not all the rest. */
type ResourceProducts = Pick<CapacityProductIds, "monthly" | "monthlyAdd"> &
  Partial<Pick<CapacityProductIds, "oneTime" | "overage">>;

/** An add-on product, as the webhook routes it. */
export type CapacityProductKind = {
  resource: CapacityResource;
  kind: "one_time" | "monthly" | "monthly_add" | "overage";
};

interface ResourceSpec {
  /** The recurring blocks' and overage's subscription kinds (null: not sold). */
  blocks: CapacityKind;
  overage: CapacityKind | null;
  /** One-time blocks (null: not sold), and blocks added to the subscription mid-period. */
  credits: PurchaseKind | null;
  increase: PurchaseKind;
  blockSize: number;
  maxBlocks: number;
  defaultOverageMax: number;
  /** Where the account's settings show them, and the anchor there. */
  accountPath: string;
  anchor: string;
  products: () => ResourceProducts | null;
  /** In the customer's words. */
  noun: string;
}

const RESOURCES: Record<CapacityResource, ResourceSpec> = {
  requests: {
    blocks: "blocks",
    overage: "overage",
    credits: "credits",
    increase: "block_increase",
    blockSize: BLOCK_REQUESTS,
    maxBlocks: MAX_BLOCKS,
    defaultOverageMax: DEFAULT_OVERAGE_MAX_REQUESTS,
    accountPath: "/account/plan",
    anchor: "extra-requests",
    products: getCapacityProductIds,
    noun: "requests",
  },
  pages: {
    blocks: "page_blocks",
    overage: "page_overage",
    credits: "page_credits",
    increase: "page_block_increase",
    blockSize: BLOCK_PAGES,
    maxBlocks: MAX_PAGE_BLOCKS,
    defaultOverageMax: DEFAULT_PAGE_OVERAGE_MAX_PAGES,
    accountPath: "/account/plan",
    anchor: "extra-pages",
    products: getPageProductIds,
    noun: "parsed pages",
  },
  domains: {
    blocks: "domain_blocks",
    overage: null,
    credits: null,
    increase: "domain_increase",
    blockSize: 1,
    maxBlocks: MAX_EXTRA_DOMAINS,
    defaultOverageMax: 0,
    accountPath: "/account/domains",
    anchor: "extra-domains",
    products: getDomainProductIds,
    noun: "domains",
  },
};

const PAGE_KINDS = new Set<CapacityKind>(["page_blocks", "page_overage"]);
const DOMAIN_KINDS = new Set<CapacityKind>(["domain_blocks"]);
const BLOCK_KINDS = new Set<CapacityKind>(["blocks", "page_blocks", "domain_blocks"]);

/** Where paid recurring blocks of a kind are kept when they cannot renew (none for domains). */
function creditsFor(kind: CapacityKind): PurchaseKind | null {
  if (kind === "blocks") return "credits";
  if (kind === "page_blocks") return "page_credits";
  return null;
}

/** Why a complimentary (staff) team cannot buy add-ons: there is no subscription to add them to. */
export const COMPLIMENTARY_TEAM_ADDONS_MESSAGE =
  "This team is complimentary (staff) and has no subscription to add to";

/**
 * Why a person whose plan was given without a subscription (a staff account)
 * cannot buy add-ons: they are added to a subscription, and there is none.
 */
export const UNSUBSCRIBED_ADDONS_MESSAGE: Record<CapacityResource, string> = {
  requests:
    "Extra requests are added to a plan subscription, and this account's plan has none (it was given without one)",
  pages:
    "Extra parsed pages are added to a plan subscription, and this account's plan has none (it was given without one)",
  domains:
    "Extra domains are added to a plan subscription, and this account's plan has none (it was given without one)",
};

export class CapacityError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "CapacityError";
    this.code = code;
    this.status = status;
  }
}

/**
 * The capacity state in the units it counts. The request names came first
 * and stay; the unit names say the same for every resource.
 */
export interface CapacityState extends CapacityStateCore {
  /** What the counts below count: requests, parsed pages or custom domains. */
  unit: CapacityResource;
  /**
   * The plan allows these add-ons but is held without a Polar subscription
   * (a complimentary staff team, or a staff account given its plan), so
   * there is nothing to add them to and `eligible` is false. The reason to
   * show is that, not an upgrade.
   */
  noSubscription: boolean;
  /** planRequests, named for any resource: what the plan itself includes. */
  planUnits: number;
  /** blockRequests: what monthly blocks add this period. */
  blockUnits: number;
  /** creditRequests: one-time blocks left. */
  creditUnits: number;
  overage: CapacityStateCore["overage"] & {
    /** maxRequests: the overage cap this period. */
    maxUnits: number;
    /** usedRequests: overage used this period. */
    usedUnits: number;
  };
}

interface CapacityStateCore {
  /** False until the four Polar products are configured. */
  offered: boolean;
  /** The account has a live plan (Pro, or a subscribed team) and may buy add-ons. */
  eligible: boolean;
  /**
   * The plan is set to end at periodEnd. Monthly blocks and overage end with
   * it and cannot be started or kept until the plan is kept.
   */
  planEnding: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * What the plan itself includes per period (requests; pages or domains for
   * those resources): see `planUnits`.
   */
  planRequests: number;
  /** Requests added by recurring blocks this period. */
  blockRequests: number;
  /** Requests used out of planRequests + blockRequests. */
  used: number;
  /** One-time blocks left, in requests. */
  creditRequests: number;
  blocks: {
    /** Blocks granted for this period. */
    units: number;
    /** The count the next renewal brings (null when not known yet). */
    pendingUnits: number | null;
    cancelAtPeriodEnd: boolean;
    pastDue: boolean;
    periodEnd: string | null;
  } | null;
  overage: {
    subscribed: boolean;
    /** Counting now: subscribed, paid up, and the plan is live. */
    active: boolean;
    cancelAtPeriodEnd: boolean;
    pastDue: boolean;
    maxRequests: number;
    usedRequests: number;
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface AccountRow {
  plan_active: boolean;
  /**
   * A team live without a Polar subscription (a staff team, migration
   * 00108): its plan counts, but it has nothing to add add-ons to.
   */
  complimentary: boolean;
  /**
   * A person's plan that would allow each add-on, held without a Polar
   * subscription (a staff account on Business): there is nothing to add
   * add-ons to, which is the reason to give rather than an upgrade.
   */
  unsubscribed: Record<CapacityResource, boolean>;
  /** Page add-ons count: Business, or Team Business, on a live plan. */
  pages_active: boolean;
  /** Extra pages end at the renewal: the plan changes to one without them. */
  pages_ending: boolean;
  /** Extra domains count: a plan with custom domains (Business, Team Business), live. */
  domains_active: boolean;
  /** Extra domains end at the renewal: the plan changes to one without custom domains. */
  domains_ending: boolean;
  /** The plan's own custom domains (its entitlements), and the extra ones counting now. */
  plan_custom_domains: number;
  /** The plan's domains the account holds now, as inbound_domains_allowed() counts them. */
  domains_included: number;
  extra_domains: number;
  /**
   * The quota period is the plan's last before it ends or changes: always
   * for monthly plans, only the year's last month on an annual plan (a
   * person's or a team's), whose add-ons renew monthly until then.
   */
  last_period: boolean;
  /** An annual plan's billing period end (null for monthly plans). */
  annual_end: string | null;
  /** Pages count per quota period; otherwise (Free) a month from the first parse. */
  pages_follow_period: boolean;
  /** The plan's own pages per window (its entitlements). */
  plan_pages: number;
  credit_pages: number;
  page_block_pages: number;
  page_overage_active: boolean;
  page_overage_max: number;
  cancel_at_period_end: boolean;
  polar_customer_id: string | null;
  requests_used: number;
  request_limit: number;
  block_requests: number;
  credit_requests: number;
  overage_active: boolean;
  overage_max: number;
  overage_used: number;
  overage_period_start: string | null;
  period_start: string | null;
  period_end: string | null;
}

const ACCOUNT_COLUMNS =
  "polar_customer_id, cancel_at_period_end, requests_used, request_limit, block_requests, credit_requests, overage_active, overage_max, overage_used, overage_period_start, period_start, period_end, credit_pages, page_block_pages, page_overage_active, page_overage_max, extra_domains";

/** Records a refund for the account (lib/billing/refunds.ts). */
async function refundFor(
  account: CapacityAccount,
  target: RefundTarget,
  reason: "duplicate_addon" | "deleted_account" | "addon_not_applied" | "addon_ended"
): Promise<void> {
  await recordRefund({
    target,
    reason,
    userId: account.kind === "user" ? account.userId : null,
    teamId: account.kind === "team" ? account.teamId : null,
  });
}

function accountIds(account: CapacityAccount): {
  p_user_id: string | null;
  p_team_id: string | null;
} {
  return account.kind === "team"
    ? { p_user_id: null, p_team_id: account.teamId }
    : { p_user_id: account.userId, p_team_id: null };
}

async function readAccount(account: CapacityAccount): Promise<AccountRow | null> {
  const admin = createAdminClient();
  if (account.kind === "team") {
    const { data, error } = await admin
      .from("teams")
      .select(
        `${ACCOUNT_COLUMNS}, subscription_status, polar_subscription_id, business, seats, pending_plan, billing_interval, billing_period_end`
      )
      .eq("id", account.teamId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const {
      business,
      seats,
      pending_plan: pendingPlan,
      billing_interval: interval,
      billing_period_end: billingEnd,
      polar_subscription_id: subscriptionId,
      ...row
    } = data;
    const live = row.subscription_status !== null;
    const entitlements = teamEntitlements(business);
    // A change to Teams waiting for the renewal takes Team Business's
    // page and domain add-ons with it.
    const leavingBusiness = business && pendingPlan === "team";
    return {
      ...row,
      plan_active: live,
      complimentary: live && subscriptionId === null,
      unsubscribed: { requests: false, pages: false, domains: false },
      pages_active: live && entitlements.pageAddons,
      pages_ending: leavingBusiness,
      domains_active: live && entitlements.customDomains > 0,
      domains_ending: leavingBusiness,
      plan_custom_domains: entitlements.customDomains,
      domains_included: live ? entitlements.customDomains : 0,
      last_period: interval !== "year" || endsBeforeNextWindow(billingEnd, row.period_end),
      annual_end: interval === "year" ? billingEnd : null,
      pages_follow_period: true,
      plan_pages: teamAllowance(seats, business).parsedPages,
    };
  }

  const { data, error } = await admin
    .from("users")
    .select(
      `${ACCOUNT_COLUMNS}, plan, subscription_status, pending_plan, billing_interval, billing_period_end`
    )
    .eq("id", account.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const {
    pending_plan: pendingPlan,
    billing_interval: interval,
    billing_period_end: billingEnd,
    ...row
  } = data;
  const entitlements = planEntitlements(row.plan);
  return {
    ...row,
    plan_active: entitlements.requestAddons && row.subscription_status !== null,
    complimentary: false,
    unsubscribed: {
      requests: entitlements.requestAddons && row.subscription_status === null,
      pages: entitlements.pageAddons && row.subscription_status === null,
      domains: entitlements.customDomains > 0 && row.subscription_status === null,
    },
    pages_active: entitlements.pageAddons && row.subscription_status !== null,
    pages_ending: pendingPlan !== null && !planEntitlements(pendingPlan).pageAddons,
    domains_active: entitlements.customDomains > 0 && row.subscription_status !== null,
    domains_ending: pendingPlan !== null && planEntitlements(pendingPlan).customDomains === 0,
    plan_custom_domains: entitlements.customDomains,
    domains_included: entitlements.customDomains,
    last_period: interval !== "year" || endsBeforeNextWindow(billingEnd, row.period_end),
    annual_end: interval === "year" ? billingEnd : null,
    plan_pages: entitlements.parsedPages,
    pages_follow_period: entitlements.quotaPeriod === "month",
  };
}

/**
 * Whether an annual plan ends before the window after `windowEnd` would:
 * the window ending then is its last. The plan's own windows end exactly
 * with its year, but an add-on's period can sit a few days off them (one
 * aligned before migration 00084, or before it caught up after a short
 * month), so the next window is what counts.
 */
function endsBeforeNextWindow(planEnd: string | null, windowEnd: string | null): boolean {
  if (!planEnd || !windowEnd) return true;
  return Date.parse(planEnd) < Date.parse(addMonthUtc(windowEnd)) - 60_000;
}

async function liveSubscriptions(account: CapacityAccount): Promise<CapacitySubscriptionRow[]> {
  const admin = createAdminClient();
  let query = admin.from("capacity_subscriptions").select("*").not("status", "is", null);
  query =
    account.kind === "team"
      ? query.eq("team_id", account.teamId)
      : query.eq("user_id", account.userId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

function liveOfKind(
  rows: CapacitySubscriptionRow[],
  kind: CapacityKind
): CapacitySubscriptionRow | null {
  return rows.find((row) => row.kind === kind) ?? null;
}

async function ensureCustomer(account: CapacityAccount, ownerUserId: string): Promise<string> {
  if (account.kind === "team") {
    return ensureTeamPolarCustomerId(await getTeamForOwner(ownerUserId, account.teamId));
  }
  return ensurePolarCustomerId(await getBillingUser(account.userId));
}

async function successUrl(
  account: CapacityAccount,
  what: string,
  spec: Pick<ResourceSpec, "accountPath" | "anchor"> = RESOURCES.requests
): Promise<string> {
  const appUrl = await returnOrigin(publicEnv().NEXT_PUBLIC_APP_URL);
  return account.kind === "team"
    ? `${appUrl}/teams/${account.teamId}?capacity=${what}#${spec.anchor}`
    : `${appUrl}${spec.accountPath}?capacity=${what}#${spec.anchor}`;
}

function notOffered(resource: CapacityResource): CapacityError {
  return new CapacityError(
    "not_offered",
    `Extra ${RESOURCES[resource].noun} are not available yet`,
    404
  );
}

function requireProducts(resource: CapacityResource = "requests"): ResourceProducts {
  const products = RESOURCES[resource].products();
  if (!products) throw notOffered(resource);
  return products;
}

/**
 * The account, when it may buy extra requests: it needs a live plan. Monthly
 * blocks and overage (`renewing`) also need the plan to go on, because they
 * end with it; started while it is ending, Polar would renew them after.
 */
async function requireEligible(
  account: CapacityAccount,
  {
    renewing = false,
    resource = "requests",
  }: { renewing?: boolean; resource?: CapacityResource } = {}
): Promise<AccountRow> {
  const row = await readAccount(account);
  if (!row) {
    throw new CapacityError("not_found", "Account not found", 404);
  }
  if (row.complimentary) {
    throw new CapacityError("plan_required", COMPLIMENTARY_TEAM_ADDONS_MESSAGE);
  }
  if (row.unsubscribed[resource]) {
    throw new CapacityError("plan_required", UNSUBSCRIBED_ADDONS_MESSAGE[resource]);
  }
  if (resource === "pages" && !row.pages_active) {
    throw new CapacityError(
      "plan_required",
      account.kind === "team"
        ? "Extra parsed pages come with Team Business. Upgrade the team first."
        : "Extra parsed pages are part of Business. Upgrade first."
    );
  }
  if (resource === "domains" && !row.domains_active) {
    throw new CapacityError(
      "plan_required",
      account.kind === "team"
        ? "Custom domains come with Team Business. Upgrade the team first."
        : "Custom domains are part of Business. Upgrade first."
    );
  }
  if (!row.plan_active) {
    throw new CapacityError(
      "plan_required",
      account.kind === "team"
        ? "The team needs an active subscription before it can add requests"
        : "Extra requests are part of Pro. Upgrade first."
    );
  }
  if (renewing && resource !== "requests") {
    const noun = resource === "pages" ? "extra parsed pages" : "extra domains";
    const ending = resource === "pages" ? row.pages_ending : row.domains_ending;
    if (ending && row.last_period) {
      throw new CapacityError(
        "plan_ending",
        account.kind === "team"
          ? `The team moves to Teams at the renewal, and ${noun} end with Team Business. Keep Team Business first.`
          : `Your plan changes from Business at the renewal, and ${noun} end with it. Keep Business first.`
      );
    }
  }
  if (renewing && row.cancel_at_period_end && row.last_period) {
    throw new CapacityError(
      "plan_ending",
      account.kind === "team"
        ? "The team's subscription is set to end, and monthly blocks and overage end with it. Keep the subscription first."
        : "Pro is set to end, and monthly blocks and overage end with it. Keep Pro first."
    );
  }
  return row;
}

/**
 * The account a user may manage: their own, or a team they own. Throws the
 * team module's not_owner error for anyone else.
 */
export async function assertCanManage(account: CapacityAccount, userId: string): Promise<void> {
  if (account.kind === "team") {
    await getTeamForOwner(userId, account.teamId);
  } else if (account.userId !== userId) {
    throw new CapacityError("forbidden", "Not your account", 403);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function getCapacityState(
  account: CapacityAccount,
  resource: CapacityResource = "requests"
): Promise<CapacityState> {
  const row = await readAccount(account);
  if (!row) {
    throw new CapacityError("not_found", "Account not found", 404);
  }
  const core =
    resource === "pages"
      ? await pageState(account, row)
      : resource === "domains"
        ? await domainState(account, row)
        : await requestState(account, row);
  const planAllows =
    resource === "pages"
      ? row.pages_active
      : resource === "domains"
        ? row.domains_active
        : row.plan_active;
  return withUnits(core, resource, (row.complimentary && planAllows) || row.unsubscribed[resource]);
}

/** The state with its unit and the neutral names beside the request ones. */
function withUnits(
  core: CapacityStateCore,
  unit: CapacityResource,
  noSubscription: boolean
): CapacityState {
  return {
    ...core,
    unit,
    noSubscription,
    planUnits: core.planRequests,
    blockUnits: core.blockRequests,
    creditUnits: core.creditRequests,
    overage: {
      ...core.overage,
      maxUnits: core.overage.maxRequests,
      usedUnits: core.overage.usedRequests,
    },
  };
}

async function requestState(account: CapacityAccount, row: AccountRow): Promise<CapacityStateCore> {
  const subscriptions = await liveSubscriptions(account);
  const blocks = liveOfKind(subscriptions, "blocks");
  const overage = liveOfKind(subscriptions, "overage");

  return {
    offered: getCapacityProductIds() !== null,
    eligible: row.plan_active && !row.complimentary,
    planEnding: row.plan_active && row.cancel_at_period_end && row.last_period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    planRequests: row.request_limit,
    blockRequests: row.block_requests,
    used: row.requests_used,
    creditRequests: row.credit_requests,
    blocks: blocks
      ? {
          units: blocks.units,
          pendingUnits: blocks.pending_units,
          cancelAtPeriodEnd: blocks.cancel_at_period_end,
          pastDue: blocks.status === "past_due",
          periodEnd: blocks.period_end,
        }
      : null,
    overage: {
      subscribed: overage !== null,
      active: row.overage_active,
      cancelAtPeriodEnd: overage?.cancel_at_period_end ?? false,
      pastDue: overage?.status === "past_due",
      maxRequests: row.overage_max,
      usedRequests: periodOverageUsed(row),
    },
  };
}

/**
 * Parsed pages in the same shape: the plan's pages and blocks this window,
 * what was used, credits, and page overage (the request names stand for
 * pages here). The window and its usage come from parsed_pages_balance(),
 * the same numbers a parse is charged against.
 */
async function pageState(account: CapacityAccount, row: AccountRow): Promise<CapacityStateCore> {
  const [pages, subscriptions] = await Promise.all([
    pageWindow(account, row),
    liveSubscriptions(account),
  ]);
  const blocks = liveOfKind(subscriptions, "page_blocks");
  const overage = liveOfKind(subscriptions, "page_overage");
  const overageMax = row.page_overage_max;
  return {
    offered: getPageProductIds() !== null,
    eligible: row.pages_active && !row.complimentary,
    // Extra pages end with the plan, or a change away from Business or
    // Team Business.
    planEnding:
      row.pages_active && row.last_period && (row.cancel_at_period_end || row.pages_ending),
    periodStart: pages.periodStart,
    periodEnd: pages.periodEnd,
    planRequests: pages.planPages,
    blockRequests: pages.blockPages,
    used: pages.used,
    creditRequests: pages.creditPages,
    blocks: blocks
      ? {
          units: blocks.units,
          pendingUnits: blocks.pending_units,
          cancelAtPeriodEnd: blocks.cancel_at_period_end,
          pastDue: blocks.status === "past_due",
          periodEnd: blocks.period_end,
        }
      : null,
    overage: {
      subscribed: overage !== null,
      active: row.page_overage_active,
      cancelAtPeriodEnd: overage?.cancel_at_period_end ?? false,
      pastDue: overage?.status === "past_due",
      maxRequests: overageMax,
      usedRequests: pages.overageUsed,
    },
  };
}

/** Parsed pages in the account's page window, as parsed_pages_balance() charges them. */
export interface PageWindow {
  periodStart: string | null;
  periodEnd: string | null;
  /** The window's own pages, pro rata after a mid-period upgrade. */
  planPages: number;
  blockPages: number;
  used: number;
  creditPages: number;
  overageActive: boolean;
  overageUsed: number;
  overageMax: number;
}

async function pageWindow(account: CapacityAccount, row: AccountRow): Promise<PageWindow> {
  const { data, error } = await createAdminClient().rpc(
    "parsed_pages_balance",
    accountIds(account)
  );
  if (error) throw error;
  const balance = (Array.isArray(data) ? data[0] : data) as {
    window_start: string | null;
    allowance: number;
    used: number;
    credits: number;
    overage_left: number;
  } | null;
  const overageMax = row.page_overage_max;
  return {
    periodStart: balance?.window_start ?? row.period_start,
    periodEnd: row.pages_follow_period
      ? row.period_end
      : balance?.window_start && Number(balance.used) > 0
        ? addMonthUtc(balance.window_start)
        : null,
    planPages: balance ? Math.max(balance.allowance - row.page_block_pages, 0) : row.plan_pages,
    blockPages: row.page_block_pages,
    used: Number(balance?.used ?? 0),
    creditPages: Number(row.credit_pages),
    overageActive: row.page_overage_active,
    overageUsed: Math.max(overageMax - Number(balance?.overage_left ?? overageMax), 0),
    overageMax,
  };
}

/**
 * Just the page window, for usage reads: the numbers of the capacity state
 * without the add-on subscriptions, which only buying needs.
 */
export async function getPageWindow(account: CapacityAccount): Promise<PageWindow> {
  const row = await readAccount(account);
  if (!row) {
    throw new CapacityError("not_found", "Account not found", 404);
  }
  return pageWindow(account, row);
}

/**
 * Custom domains in the same shape, counted in domains: the plan's own
 * (planRequests), the extra ones (blockRequests) and the ones added (used).
 * There are no one-time domains and no overage.
 */
async function domainState(account: CapacityAccount, row: AccountRow): Promise<CapacityStateCore> {
  const admin = createAdminClient();
  let query = admin.from("inbound_domains").select("id", { count: "exact", head: true });
  query =
    account.kind === "team"
      ? query.eq("team_id", account.teamId)
      : query.eq("user_id", account.userId);
  const { count, error } = await query;
  if (error) throw error;
  const subscriptions = await liveSubscriptions(account);
  const blocks = liveOfKind(subscriptions, "domain_blocks");
  return {
    offered: getDomainProductIds() !== null,
    eligible: row.domains_active && !row.complimentary,
    planEnding:
      row.domains_active && row.last_period && (row.cancel_at_period_end || row.domains_ending),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    // What inbound_domains_allowed() grants: a person's plan includes its
    // domains whether or not a subscription is live (a staff account has
    // none), a team's only while subscribed.
    planRequests: row.domains_included,
    blockRequests: row.domains_included > 0 ? row.extra_domains : 0,
    used: count ?? 0,
    creditRequests: 0,
    blocks: blocks
      ? {
          units: blocks.units,
          pendingUnits: blocks.pending_units,
          cancelAtPeriodEnd: blocks.cancel_at_period_end,
          pastDue: blocks.status === "past_due",
          periodEnd: blocks.period_end,
        }
      : null,
    overage: {
      subscribed: false,
      active: false,
      cancelAtPeriodEnd: false,
      pastDue: false,
      maxRequests: 0,
      usedRequests: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Customer actions
// ---------------------------------------------------------------------------

/**
 * How a checkout may change its count: a session's own checkout lets the
 * customer adjust it there; one an approval opens (`exactUnits`) is pinned
 * to the count the owner approved, so the checkout cannot sell more.
 */
export interface CheckoutUnits {
  exactUnits?: boolean;
}

function unitBounds(blocks: number, maxBlocks: number, { exactUnits }: CheckoutUnits) {
  return exactUnits
    ? { min_units: blocks, max_units: blocks }
    : { min_units: 1, max_units: maxBlocks };
}

/** A checkout for one-time blocks. */
export async function createOneTimeBlocksCheckout(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource = "requests",
  units: CheckoutUnits = {}
): Promise<string> {
  await checkOneTimeBlocks(account, resource);
  return (await oneTimeBlocksCheckout(account, actingUserId, blocks, resource, undefined, units))
    .url;
}

async function checkOneTimeBlocks(
  account: CapacityAccount,
  resource: CapacityResource
): Promise<string> {
  const { oneTime } = requireProducts(resource);
  if (!oneTime) throw notOffered(resource);
  await requireEligible(account, { resource });
  return oneTime;
}

/**
 * The metadata a checkout carries: what the add-on is for, and the checkout
 * link it was made for, if any.
 */
function checkoutMetadata(
  metadata: Record<string, string | number>,
  link: CheckoutLinkContext | undefined
): Record<string, string | number> {
  return link ? { ...metadata, [CHECKOUT_LINK_METADATA_KEY]: link.id } : metadata;
}

/**
 * The checkout for one-time blocks. The dashboard's lets the person change
 * the number on Polar's page; a checkout link's sells exactly `blocks`.
 */
async function oneTimeBlocksCheckout(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource,
  link?: CheckoutLinkContext,
  units: CheckoutUnits = {}
): Promise<CheckoutSession> {
  const spec = RESOURCES[resource];
  const { oneTime } = requireProducts(resource);
  const customerId = await ensureCustomer(account, actingUserId);
  const checkout = await createPolarClient().checkouts.create({
    products: [oneTime as string],
    units: blocks,
    ...unitBounds(blocks, spec.maxBlocks, link ? { exactUnits: true } : units),
    customer_id: customerId,
    success_url: link?.successUrl ?? (await successUrl(account, "blocks", spec)),
    metadata: checkoutMetadata({ capacity: "one_time", resource }, link),
  });
  return checkoutSession(checkout);
}

/** One-time blocks bought through a checkout link (lib/billing/checkout-links.ts). */
export async function oneTimeBlocksPurchase(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource = "requests"
): Promise<LinkPurchase> {
  await assertCanManage(account, actingUserId);
  const product = await checkOneTimeBlocks(account, resource);
  return {
    expected: { product, units: blocks },
    mint: (link) => oneTimeBlocksCheckout(account, actingUserId, blocks, resource, link),
  };
}

/**
 * The checkout for monthly blocks: a new subscription for `blocks` when the
 * account has none (`current` null), else a one-time order at the full
 * monthly price for the blocks above `current`'s. A checkout link's new
 * subscription sells exactly `blocks`; the dashboard's lets the person
 * change the number on Polar's page.
 */
async function monthlyBlocksCheckout(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource,
  current: CapacitySubscriptionRow | null,
  link?: CheckoutLinkContext,
  units: CheckoutUnits = {}
): Promise<CheckoutSession> {
  const spec = RESOURCES[resource];
  const customerId = await ensureCustomer(account, actingUserId);
  const success = link?.successUrl ?? (await successUrl(account, "monthly", spec));
  if (!current) {
    return checkoutSession(
      await createPolarClient().checkouts.create({
        products: [requireProducts(resource).monthly],
        units: blocks,
        ...unitBounds(blocks, spec.maxBlocks, link ? { exactUnits: true } : units),
        customer_id: customerId,
        success_url: success,
        metadata: checkoutMetadata({ capacity: "monthly", resource }, link),
      })
    );
  }
  const added = blocks - current.units;
  return checkoutSession(
    await createPolarClient().checkouts.create({
      products: [requireProducts(resource).monthlyAdd],
      units: added,
      min_units: added,
      max_units: added,
      customer_id: customerId,
      success_url: success,
      // base_units: the count the top-up adds to, so a payment made after
      // the count moved (blocks added or cut meanwhile) is told apart.
      metadata: checkoutMetadata(
        {
          capacity: "monthly_add",
          resource,
          subscription_id: current.polar_subscription_id,
          base_units: current.units,
        },
        link
      ),
    })
  );
}

/**
 * Monthly blocks up to `blocks` in all, bought through a checkout link. Only
 * ever a purchase: the same number or fewer is refused (not_a_purchase),
 * since that changes a subscription without the person paying, which stays
 * with a session (changeMonthlyBlocks()).
 */
export async function monthlyBlocksPurchase(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource = "requests"
): Promise<LinkPurchase & { have: number }> {
  await assertCanManage(account, actingUserId);
  const spec = RESOURCES[resource];
  const products = requireProducts(resource);
  await requireEligible(account, { renewing: true, resource });
  const current = liveOfKind(await liveSubscriptions(account), spec.blocks);
  if (current?.status === "past_due") {
    throw new CapacityError(
      "past_due",
      "The last payment for the monthly blocks failed. Update the payment method under Invoices and payment method first."
    );
  }
  if (current && blocks <= current.units) {
    throw new CapacityError(
      "not_a_purchase",
      `The account already has ${current.units} monthly ${current.units === 1 ? "block" : "blocks"}. A checkout link only adds blocks; fewer is a billing change to ask for instead (set_monthly_blocks).`,
      409
    );
  }
  return {
    expected: current
      ? { product: products.monthlyAdd, units: blocks - current.units }
      : { product: products.monthly, units: blocks },
    // The monthly blocks the account has now, which a top-up adds to.
    have: current?.units ?? 0,
    mint: (link) => monthlyBlocksCheckout(account, actingUserId, blocks, resource, current, link),
  };
}

export type MonthlyBlocksResult =
  { kind: "checkout"; url: string } | { kind: "scheduled"; units: number } | { kind: "unchanged" };

/**
 * Sets the number of recurring blocks. More blocks than now go through a
 * checkout at the full monthly price and count at once; fewer (0 cancels)
 * take effect at the renewal.
 */
export async function changeMonthlyBlocks(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource = "requests",
  units: CheckoutUnits = {}
): Promise<MonthlyBlocksResult> {
  const spec = RESOURCES[resource];
  // Ending them never needs the plan, and only a checkout needs the products:
  // with a product withdrawn, blocks bought before can still be cut or ended.
  if (blocks > 0) await requireEligible(account, { renewing: true, resource });
  const current = liveOfKind(await liveSubscriptions(account), spec.blocks);
  const polar = createPolarClient();

  if (!current) {
    if (blocks === 0) return { kind: "unchanged" };
    const checkout = await monthlyBlocksCheckout(
      account,
      actingUserId,
      blocks,
      resource,
      null,
      undefined,
      units
    );
    return { kind: "checkout", url: checkout.url };
  }

  if (current.status === "past_due") {
    throw new CapacityError(
      "past_due",
      "The last payment for your monthly blocks failed. Update your payment method under Invoices and payment method first."
    );
  }

  if (blocks === 0) {
    if (!current.cancel_at_period_end) {
      await polar.subscriptions.update(current.polar_subscription_id, {
        cancel_at_period_end: true,
      });
    }
    // Ending them is now the customer's own choice, so keeping the plan does
    // not bring them back.
    await markSubscription(current.id, { cancel_at_period_end: true, canceled_with_plan: false });
    return { kind: "scheduled", units: 0 };
  }

  // More blocks: the paid order keeps blocks that were set to end
  // (applyPaidOrder), so an abandoned checkout changes nothing.
  if (blocks > current.units) {
    const checkout = await monthlyBlocksCheckout(account, actingUserId, blocks, resource, current);
    return { kind: "checkout", url: checkout.url };
  }

  // Keeping blocks that were set to end.
  const wasEnding = current.cancel_at_period_end;
  if (wasEnding) {
    await polar.subscriptions.update(current.polar_subscription_id, {
      cancel_at_period_end: false,
    });
    await markSubscription(current.id, { cancel_at_period_end: false, canceled_with_plan: false });
  }

  // What Polar renews at is Polar's to say: after a paid mid-period
  // increase its own count stays lower than ours until the renewal, and
  // scheduling its own count again just clears the scheduled change.
  const live = await polar.subscriptions.get(current.polar_subscription_id);
  const liveUnits = typeof live.units === "number" ? live.units : current.units;
  const renewsAt = live.pending_update?.units ?? liveUnits;
  if (blocks === renewsAt) {
    await markSubscription(current.id, { pending_units: renewsAt });
    return wasEnding ? { kind: "scheduled", units: blocks } : { kind: "unchanged" };
  }

  if (blocks === liveUnits) {
    await polar.subscriptions.update(current.polar_subscription_id, { pending_update: null });
    await markSubscription(current.id, { pending_units: blocks });
    return { kind: "scheduled", units: blocks };
  }

  // Any other count, from the renewal.
  await polar.subscriptions.update(current.polar_subscription_id, {
    units: blocks,
    proration_behavior: "next_period",
  });
  await markSubscription(current.id, { pending_units: blocks });
  return { kind: "scheduled", units: blocks };
}

export type OverageResult = { kind: "checkout"; url: string } | { kind: "updated" };

/**
 * Turns overage on (with a maximum per plan period) or off. Turning it off
 * stops counting at once and ends the subscription at the period end, when
 * Polar bills what was used. The maximum is stored before any checkout, so
 * it applies the moment the subscription starts.
 */
export async function setOverage(
  account: CapacityAccount,
  actingUserId: string,
  options: { enabled: boolean; maxRequests?: number },
  resource: CapacityResource = "requests"
): Promise<OverageResult> {
  const spec = RESOURCES[resource];
  const products = requireProducts(resource);
  if (!spec.overage || !products.overage) throw notOffered(resource);
  const overageProduct = products.overage;
  const current = liveOfKind(await liveSubscriptions(account), spec.overage);
  const polar = createPolarClient();

  if (!options.enabled) {
    const previousMax = await readOverageMax(account, resource);
    await changeOverageMax(account, 0, previousMax, resource, async () => {
      if (current && !current.cancel_at_period_end) {
        await polar.subscriptions.update(current.polar_subscription_id, {
          cancel_at_period_end: true,
        });
      }
    });
    if (current && !current.cancel_at_period_end) {
      await markSubscription(current.id, { cancel_at_period_end: true, canceled_with_plan: false });
    } else if (current?.canceled_with_plan) {
      // Ending with the plan already: turned off, it must not come back with it.
      await markSubscription(current.id, { canceled_with_plan: false });
    }
    return { kind: "updated" };
  }

  const row = await requireEligible(account, { renewing: true, resource });
  const storedMax = resource === "pages" ? row.page_overage_max : row.overage_max;
  const maxRequests = options.maxRequests ?? (storedMax > 0 ? storedMax : spec.defaultOverageMax);
  if (!isValidOverageMax(spec, maxRequests)) {
    throw new CapacityError(
      "invalid_max",
      `The maximum must be a whole number of ${spec.blockSize.toLocaleString("en-US")} blocks`,
      400
    );
  }
  if (current?.status === "past_due") {
    throw new CapacityError(
      "past_due",
      "The last overage payment failed. Update your payment method under Invoices and payment method first."
    );
  }
  // The customer first: making one is a Polar call, and the maximum is
  // written only once nothing but the change itself is left to fail.
  const customerId = current ? null : await ensureCustomer(account, actingUserId);
  const checkoutUrl = await changeOverageMax(
    account,
    maxRequests,
    storedMax,
    resource,
    async () => {
      if (customerId !== null) {
        const checkout = await overageCheckout(
          account,
          actingUserId,
          overageProduct,
          resource,
          undefined,
          customerId
        );
        return checkout.url;
      }
      if (current?.cancel_at_period_end) {
        await polar.subscriptions.update(current.polar_subscription_id, {
          cancel_at_period_end: false,
        });
      }
      return null;
    }
  );
  if (checkoutUrl !== null) return { kind: "checkout", url: checkoutUrl };

  if (current?.cancel_at_period_end) {
    await markSubscription(current.id, { cancel_at_period_end: false, canceled_with_plan: false });
  }
  return { kind: "updated" };
}

/**
 * Writes the overage maximum, then makes the Polar call that goes with it
 * (`polarCall`, which may make none). Under a billing change an owner
 * approved, the change's lease is checked before the write (the Polar
 * mutation guard), so a refusal there leaves the maximum as it was and
 * "nothing was changed" stays true. When the Polar call fails, the
 * previous maximum is written back: Polar did not take the change, so the
 * account must not count against a maximum nobody got.
 */
async function changeOverageMax<T>(
  account: CapacityAccount,
  max: number,
  previousMax: number,
  resource: CapacityResource,
  polarCall: () => Promise<T>
): Promise<T> {
  await currentPolarMutationGuard()?.beforeMutation("overage.max");
  await writeOverageMax(account, max, resource);
  try {
    return await polarCall();
  } catch (error) {
    // Put the old maximum back when that can only charge less (it was
    // lower), or when Polar certainly did not take the change. After a
    // timeout Polar may have turned overage off, and a higher old maximum
    // would let the account keep spending past what the owner approved.
    if (previousMax !== max && (previousMax < max || polarCertainlyRefused(error))) {
      try {
        await writeOverageMax(account, previousMax, resource);
      } catch (restoreError) {
        reportError("Restoring the overage maximum after a failed Polar call failed", restoreError);
      }
    }
    throw error;
  }
}

/**
 * Whether a failed Polar call certainly left Polar unchanged: the mutation
 * guard refused before the call went out (a BillingChangeRetry), or Polar
 * answered with a 4xx. A timeout, a network error or a 5xx may have been
 * applied.
 */
export function polarCertainlyRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { name?: unknown }).name === "BillingChangeRetry") return true;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

async function readOverageMax(
  account: CapacityAccount,
  resource: CapacityResource
): Promise<number> {
  const admin = createAdminClient();
  const column = resource === "pages" ? "page_overage_max" : "overage_max";
  const { data, error } =
    account.kind === "team"
      ? await admin.from("teams").select(column).eq("id", account.teamId).maybeSingle()
      : await admin.from("users").select(column).eq("id", account.userId).maybeSingle();
  if (error) throw error;
  const value = (data as Record<string, unknown> | null)?.[column];
  return typeof value === "number" ? value : 0;
}

async function overageCheckout(
  account: CapacityAccount,
  actingUserId: string,
  overageProduct: string,
  resource: CapacityResource,
  link?: { context: CheckoutLinkContext; max: number },
  /** The customer, when the caller made sure of it already. */
  knownCustomerId?: string
): Promise<CheckoutSession> {
  const customerId = knownCustomerId ?? (await ensureCustomer(account, actingUserId));
  const checkout = await createPolarClient().checkouts.create({
    products: [overageProduct],
    customer_id: customerId,
    success_url:
      link?.context.successUrl ?? (await successUrl(account, "overage", RESOURCES[resource])),
    // A checkout link's maximum rides with the subscription and is stored
    // when it arrives (applySubscriptionEvent), so nothing changes before
    // the person pays.
    metadata: checkoutMetadata(
      link
        ? { capacity: "overage", resource, overage_max: link.max }
        : { capacity: "overage", resource },
      link?.context
    ),
  });
  return checkoutSession(checkout);
}

/**
 * Overage started through a checkout link, with the maximum the account has
 * stored, else the one the link was made with, else the default (`max`,
 * which the link's summary names). It is read again when the link is
 * opened and rides on the session's metadata, so a maximum the person
 * changed after the link was made is the one the subscription is given.
 * Only when overage has no subscription yet: turning a live one back on, or
 * changing its maximum, charges nothing new and stays with a session
 * (setOverage()). Nothing is written until the subscription arrives.
 */
export async function overagePurchase(
  account: CapacityAccount,
  actingUserId: string,
  resource: CapacityResource = "requests",
  /** The maximum the link was made with, when it is opened. */
  linkMax?: number
): Promise<LinkPurchase & { max: number }> {
  await assertCanManage(account, actingUserId);
  const spec = RESOURCES[resource];
  const products = requireProducts(resource);
  const overageProduct = products.overage;
  if (!spec.overage || !overageProduct) throw notOffered(resource);
  const current = liveOfKind(await liveSubscriptions(account), spec.overage);
  if (current) {
    throw new CapacityError(
      "not_a_purchase",
      current.cancel_at_period_end
        ? "Overage is set to end with the period. Keeping it charges nothing new, so ask for it as a billing change instead (set_overage)."
        : "Overage is already on.",
      409
    );
  }
  const row = await requireEligible(account, { renewing: true, resource });
  const storedMax = resource === "pages" ? row.page_overage_max : row.overage_max;
  const max = isValidOverageMax(spec, storedMax)
    ? storedMax
    : linkMax !== undefined && isValidOverageMax(spec, linkMax)
      ? linkMax
      : spec.defaultOverageMax;
  return {
    expected: { product: overageProduct },
    max,
    mint: (link) =>
      overageCheckout(account, actingUserId, overageProduct, resource, { context: link, max }),
  };
}

/** A maximum setOverage() would accept for the resource. */
function isValidOverageMax(spec: ResourceSpec, max: unknown): max is number {
  return (
    typeof max === "number" &&
    Number.isInteger(max) &&
    max > 0 &&
    max % spec.blockSize === 0 &&
    max <= spec.maxBlocks * spec.blockSize
  );
}

/**
 * Stores the overage maximum; with `expected`, only while the stored one is
 * still that (a compare and set: nothing is written when it moved).
 */
async function writeOverageMax(
  account: CapacityAccount,
  max: number,
  resource: CapacityResource = "requests",
  expected?: number
): Promise<void> {
  const admin = createAdminClient();
  const column = resource === "pages" ? "page_overage_max" : "overage_max";
  const patch = resource === "pages" ? { page_overage_max: max } : { overage_max: max };
  let query =
    account.kind === "team"
      ? admin.from("teams").update(patch).eq("id", account.teamId)
      : admin.from("users").update(patch).eq("id", account.userId);
  if (expected !== undefined) query = query.eq(column, expected);
  const { error } = await query;
  if (error) throw error;
}

async function markSubscription(
  id: string,
  patch: Database["public"]["Tables"]["capacity_subscriptions"]["Update"]
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("capacity_subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Which add-on a Polar product is, or null for any other product. */
export function capacityProductKind(productId: string | null): CapacityProductKind | null {
  // Each set id on its own: with one id missing, the others' events must
  // still stay away from the plan handlers.
  if (!productId) return null;
  const all: [CapacityResource, Partial<CapacityProductIds>][] = [
    ["requests", configuredCapacityProductIds()],
    ["pages", configuredPageProductIds()],
    ["domains", configuredDomainProductIds()],
  ];
  for (const [resource, products] of all) {
    if (productId === products.oneTime) return { resource, kind: "one_time" };
    if (productId === products.monthly) return { resource, kind: "monthly" };
    if (productId === products.monthlyAdd) return { resource, kind: "monthly_add" };
    if (productId === products.overage) return { resource, kind: "overage" };
  }
  return null;
}

/** The product a subscription or order payload is for. */
export function webhookProductId(data: Record<string, unknown>): string | null {
  return asNonEmptyString(data.product_id) ?? asNonEmptyString(asRecord(data.product)?.id) ?? null;
}

/** Polar subscription status as stored on an add-on, or null once it has ended. */
export function addonStatus(
  subscription: Record<string, unknown>
): CapacitySubscriptionRow["status"] {
  const status = subscription.status;
  if (
    asNonEmptyString(subscription.ended_at) ||
    status === "canceled" ||
    status === "incomplete_expired"
  ) {
    return null;
  }
  if (status === "active" || status === "trialing") {
    return subscription.cancel_at_period_end === true ? "canceled" : "active";
  }
  return "past_due";
}

function pendingUnits(subscription: Record<string, unknown>): number | null {
  const units = asRecord(subscription.pending_update)?.units;
  return typeof units === "number" && Number.isInteger(units) && units >= 0 ? units : null;
}

async function applySubscriptionState(
  account: CapacityAccount,
  kind: CapacityKind,
  subscription: Record<string, unknown>,
  ended: boolean
): Promise<string> {
  const subscriptionId = asNonEmptyString(subscription.id);
  if (!subscriptionId) return "ignored";

  const units = typeof subscription.units === "number" ? subscription.units : 0;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_capacity_subscription", {
    ...accountIds(account),
    p_kind: kind,
    p_subscription_id: subscriptionId,
    p_status: ended ? null : addonStatus(subscription),
    p_units: BLOCK_KINDS.has(kind) ? units : 0,
    // The count Polar renews at, which after a paid mid-period increase is
    // not the same as the units granted for this period.
    p_pending_units: BLOCK_KINDS.has(kind) ? (pendingUnits(subscription) ?? units) : null,
    p_cancel_at_period_end: subscription.cancel_at_period_end === true,
    p_period_start: parseEventTimestamp(subscription.current_period_start),
    p_period_end: parseEventTimestamp(subscription.current_period_end),
  });
  if (error) throw error;
  return asNonEmptyString(asRecord(data)?.status) ?? "unknown";
}

/** The most a month's end can move between months (31st to 28th), and a minute. */
const SHORT_MONTH_MS = 3 * 86_400_000 + 60_000;

/**
 * Whether an add-on that renews a little before the plan's window ends only
 * because it was aligned with a window that ended in a short month: Polar
 * takes an add-on's renewal day from the end it was given (Feb 28), while the
 * plan keeps its own day (Mar 31), Polar's monthly period and an annual
 * plan's windows (migration 00084) alike. Moving it later once,
 * by at most the three days a month can lose, puts it back on the plan's day
 * for good. Its period must still be running and end in the same month as
 * the window, which no renewal of the plan the add-on has not caught up with
 * yet can look like.
 */
function catchesUpShortMonth(addonEndMs: number, planEndMs: number): boolean {
  const addonEnd = new Date(addonEndMs);
  const planEnd = new Date(planEndMs);
  return (
    addonEndMs > Date.now() + 2 * 60_000 &&
    planEndMs - addonEndMs <= SHORT_MONTH_MS &&
    addonEnd.getUTCFullYear() === planEnd.getUTCFullYear() &&
    addonEnd.getUTCMonth() === planEnd.getUTCMonth()
  );
}

/**
 * Moves an add-on's renewal onto the plan's, so blocks and overage renew and
 * bill together with the plan. Earlier, except by the days a short month
 * took: a later end gives the add-on time nobody paid for, and when the plan
 * has just renewed, the add-on's own renewal may simply not have been
 * processed yet. Bought mid-period, an add-on's first period ends with the
 * plan's (the customer pays the full price for it, by choice). Best effort:
 * the add-on's next event tries again.
 */
async function alignWithPlan(
  account: CapacityAccount,
  subscriptionId: string,
  addonPeriodEnd: unknown
): Promise<void> {
  const row = await readAccount(account);
  if (!row?.plan_active || !row.period_end) return;
  const planEndMs = Date.parse(row.period_end);
  const addonEndMs = typeof addonPeriodEnd === "string" ? Date.parse(addonPeriodEnd) : NaN;
  if (!Number.isFinite(planEndMs) || !Number.isFinite(addonEndMs)) return;
  if (planEndMs < Date.now() + 2 * 60_000 || Math.abs(addonEndMs - planEndMs) < 60_000) return;
  if (addonEndMs < planEndMs && !catchesUpShortMonth(addonEndMs, planEndMs)) return;

  const planEnd = new Date(planEndMs).toISOString();
  try {
    await createPolarClient().subscriptions.update(subscriptionId, {
      current_billing_period_end: planEnd,
    });
  } catch (error) {
    reportError("[capacity] failed to align an add-on with the plan", loggablePolarError(error), {
      subscriptionId,
    });
    return;
  }
  // The stored end follows at once rather than with Polar's event: an end
  // moved later and stored as the old one would read as overdue to the
  // reset job's sweep (two days past the end) if that event were late.
  // Best effort: the event writes the same end.
  const { error: storeError } = await createAdminClient()
    .from("capacity_subscriptions")
    .update({ period_end: planEnd, updated_at: new Date().toISOString() })
    .eq("polar_subscription_id", subscriptionId);
  if (storeError) {
    reportError("[capacity] could not store an aligned add-on's end", storeError.message, {
      subscriptionId,
    });
  }
}

async function applySubscriptionEvent(
  eventType: string,
  account: CapacityAccount,
  kind: CapacityKind,
  data: Record<string, unknown>
): Promise<void> {
  const subscriptionId = asNonEmptyString(data.id);
  if (!subscriptionId) return;

  // Polar's payloads cannot be ordered against each other and it does not
  // bump modified_at for a scheduled change, so apply its current state. A
  // revoke is final either way.
  const revoked = eventType === "subscription.revoked";
  const subscription = revoked
    ? data
    : ((await createPolarClient().subscriptions.get(subscriptionId)) as unknown as Record<
        string,
        unknown
      >);
  // Still waiting for its first payment: nothing is granted, and it must not
  // count as the account's subscription of this kind yet. Its next event,
  // once paid (or expired), says what it became.
  if (!revoked && subscription.status === "incomplete") return;
  const ended = revoked || addonStatus(subscription) === null;

  // Overage bought through a checkout link carries its maximum. It is
  // written before the subscription is first stored (so a failure is
  // retried with the event) and never again, so a maximum changed later in
  // the dashboard stays; not when the account already has overage, since
  // this one is then a duplicate that ends. The write is conditional on the
  // maximum read before those checks, so a redelivery that raced the first
  // one never overwrites a maximum the owner changed meanwhile.
  const linkMax = ended ? null : await linkOverageMaxFor(kind, subscription);
  const seenMax = linkMax === null ? null : await readOverageMax(account, linkMax.resource);
  if (
    linkMax !== null &&
    seenMax !== null &&
    !(await isKnownSubscription(subscriptionId)) &&
    !liveOfKind(await liveSubscriptions(account), kind)
  ) {
    await writeOverageMax(account, linkMax.max, linkMax.resource, seenMax);
  }

  const status = await applySubscriptionState(account, kind, subscription, ended);

  if (status === "duplicate") {
    await settleDuplicate(account, kind, subscription);
    return;
  }

  if (status === "no_account") {
    // The account or team is gone. Deleting it revokes its add-ons first,
    // and their late events land here too: those are ended in Polar's
    // current state and change nothing (refunding them would give back
    // months that were used). One still live was bought while a checkout
    // stayed open across the deletion: nothing may keep charging for it,
    // and what it charged goes back, recorded before the revoke so a
    // failure is retried with the webhook.
    if (ended || asNonEmptyString(subscription.ended_at)) return;
    // Read again: the copy above may predate the deletion's own revoke.
    const now = asRecord(await createPolarClient().subscriptions.get(subscriptionId));
    if (!now || addonStatus(now) === null || asNonEmptyString(now.ended_at)) return;
    await refundFor(account, { subscription: subscriptionId }, "deleted_account");
    await revokeQuietly(subscriptionId);
    console.warn("[capacity] ended an add-on subscription for a deleted account");
    return;
  }

  if (status === "mismatch") {
    reportError("[capacity] add-on subscription does not match its stored account", undefined, {
      subscriptionId,
    });
    return;
  }

  if (status === "ok" && !ended) {
    // Polar only moves the period of an active subscription.
    if (addonStatus(subscription) === "active") {
      await alignWithPlan(account, subscriptionId, subscription.current_period_end);
    }
    // Bought just as the plan was set to end (a checkout opened before):
    // it ends with the plan too.
    await reconcileAddonsWithPlan(account);
  }
}

/** The overage maximum a checkout link's subscription carries, if it is one and it is valid. */
function linkOverageMax(
  kind: CapacityKind,
  subscription: Record<string, unknown>
): { max: number; resource: CapacityResource } | null {
  const entry = (Object.entries(RESOURCES) as Array<[CapacityResource, ResourceSpec]>).find(
    ([, spec]) => spec.overage === kind
  );
  const metadata = asRecord(subscription.metadata);
  if (!entry || !metadata || !asNonEmptyString(metadata[CHECKOUT_LINK_METADATA_KEY])) return null;
  const [resource, spec] = entry;
  // Polar keeps metadata values as given; a string is read as a number too.
  const raw = metadata.overage_max;
  const max = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return isValidOverageMax(spec, max) ? { max, resource } : null;
}

/**
 * The overage maximum of the checkout link whose session made the
 * subscription: the session's metadata (the maximum read when the link was
 * opened), else the link's own row.
 */
async function linkOverageMaxFor(
  kind: CapacityKind,
  subscription: Record<string, unknown>
): Promise<{ max: number; resource: CapacityResource } | null> {
  const entry = (Object.entries(RESOURCES) as Array<[CapacityResource, ResourceSpec]>).find(
    ([, spec]) => spec.overage === kind
  );
  if (!entry) return null;
  const [resource, spec] = entry;
  const fromSession = linkOverageMax(kind, subscription);
  if (fromSession) return fromSession;
  const fromRow = await checkoutLinkOverageMax(asNonEmptyString(subscription.checkout_id));
  return isValidOverageMax(spec, fromRow) ? { max: fromRow, resource } : null;
}

/** Whether the add-on subscription is already stored (any account, any status). */
async function isKnownSubscription(subscriptionId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("capacity_subscriptions")
    .select("id")
    .eq("polar_subscription_id", subscriptionId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

async function revokeQuietly(subscriptionId: string): Promise<void> {
  try {
    await createPolarClient().subscriptions.revoke(subscriptionId);
  } catch (error) {
    if (!isEndedSubscriptionError(error)) throw error;
  }
}

/**
 * Records paid monthly blocks that can no longer be used as one-time blocks,
 * once per subscription, and tells a person (a refund may suit better).
 */
async function keepAsOneTimeBlocks(
  account: CapacityAccount,
  subscriptionId: string,
  units: number,
  amount: number | null = null,
  credits: PurchaseKind = "credits"
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("grant_capacity_purchase", {
    p_order_id: `subscription:${subscriptionId}`,
    ...accountIds(account),
    p_kind: credits,
    p_units: units,
    p_amount: amount,
  });
  if (error) throw error;
  reportError("[capacity] paid monthly blocks were kept as one-time blocks", undefined, {
    subscriptionId,
  });
}

/**
 * A second subscription of a kind the account already has (a checkout
 * completed twice). Overage has charged nothing yet, so it simply ends.
 * Paid blocks end too, and what was paid for them is kept as one-time
 * blocks, recorded once under the subscription's id, so nothing keeps
 * charging and nothing paid for is lost; paid domains go back as a refund.
 * A checkout link whose session made it reads superseded, never paid.
 */
async function settleDuplicate(
  account: CapacityAccount,
  kind: CapacityKind,
  subscription: Record<string, unknown>
): Promise<void> {
  const subscriptionId = asNonEmptyString(subscription.id);
  if (!subscriptionId) return;
  // Grant before revoking: once revoked, a redelivery reads the subscription
  // as ended and never comes back here. The grant is recorded once under the
  // subscription's id, so a retry grants nothing twice.
  const units = typeof subscription.units === "number" ? subscription.units : 0;
  const credits = creditsFor(kind);
  if (credits && units >= 1) {
    await keepAsOneTimeBlocks(
      account,
      subscriptionId,
      units,
      typeof subscription.amount === "number" ? subscription.amount : null,
      credits
    );
  }
  if (kind === "domain_blocks") {
    // Domains have no one-time form to keep what was paid: it goes back.
    await refundFor(account, { subscription: subscriptionId }, "duplicate_addon");
  }
  // Before the revoke: a redelivery after it reads the subscription as
  // ended and never comes back here.
  await supersedeCheckoutLinks(
    asNonEmptyString(subscription.checkout_id),
    subscription.metadata,
    asNonEmptyString(subscription.customer_id)
  );
  await revokeQuietly(subscriptionId);
}

async function applyPaidOrder(
  account: CapacityAccount,
  resource: CapacityResource,
  productKind: "one_time" | "monthly_add",
  data: Record<string, unknown>
): Promise<void> {
  const spec = RESOURCES[resource];
  const orderId = asNonEmptyString(data.id);
  const units = typeof data.units === "number" && Number.isInteger(data.units) ? data.units : 0;
  if (!orderId || units < 1) {
    reportError("[capacity] paid order without units", undefined, { orderId });
    return;
  }

  const kind = productKind === "one_time" ? spec.credits : spec.increase;
  if (!kind) return;
  const admin = createAdminClient();
  const { data: result, error } = await admin.rpc("grant_capacity_purchase", {
    p_order_id: orderId,
    ...accountIds(account),
    p_kind: kind,
    p_units: units,
    p_amount: typeof data.total_amount === "number" ? data.total_amount : null,
  });
  if (error) throw error;

  const granted = asRecord(result);
  if (granted?.status === "no_account") {
    // Paid for an account or team deleted while the checkout was open.
    await refundFor(account, { order: orderId }, "deleted_account");
    return;
  }
  if (granted?.unapplied === true) {
    // Domains added to a subscription that ended while the checkout was open.
    await refundFor(account, { order: orderId }, "addon_not_applied");
    await supersedeCheckoutLinks(
      asNonEmptyString(data.checkout_id),
      data.metadata,
      asNonEmptyString(data.customer_id)
    );
    return;
  }
  await checkTopUpBase(data, granted, units);
  if (granted?.kind !== spec.increase || granted.synced === true) return;
  const subscriptionId = asNonEmptyString(granted.subscription_id);
  if (!subscriptionId) {
    // A redelivery of the order above whose refund was not recorded (the
    // purchase was, so it reads as a duplicate): record it now.
    if (granted.status === "duplicate" && granted.kind === "domain_increase") {
      await refundFor(account, { order: orderId }, "addon_not_applied");
      await supersedeCheckoutLinks(
        asNonEmptyString(data.checkout_id),
        data.metadata,
        asNonEmptyString(data.customer_id)
      );
    }
    return;
  }
  await syncIncreaseToPolar(account, orderId, subscriptionId, data);
  // The plan may have been set to end since the checkout was opened.
  await reconcileAddonsWithPlan(account);
}

/**
 * A monthly top-up adds to the count its checkout was made for
 * (`base_units` in its metadata). Paid after that count moved (blocks
 * added in another tab, or cut at a renewal), the subscription now holds
 * another total than the person was shown: a person is told, and the
 * checkout link it came from reads `matches: false`. The grant's
 * target_units is the count after this order, stored with the purchase,
 * so a redelivery finds the same answer.
 */
async function checkTopUpBase(
  order: Record<string, unknown>,
  granted: Record<string, unknown> | null,
  units: number
): Promise<void> {
  const raw = asRecord(order.metadata)?.base_units;
  const base = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  const target = granted?.target_units;
  if (typeof base !== "number" || typeof target !== "number") return;
  if (target - units === base) return;
  reportError(
    "[capacity] a monthly top-up was paid on another count than it was made for",
    undefined,
    {
      orderId: asNonEmptyString(order.id),
      base,
      before: target - units,
    }
  );
  await markCheckoutLinkMismatch(asNonEmptyString(order.checkout_id), "base");
}

/**
 * After a paid mid-period increase, the subscription itself bills the new
 * count from the renewal on. It renews at the row's count now (which also
 * covers an increase processed alongside), and a subscription set to end
 * by the customer is kept, since they just paid for more, unless the plan
 * itself is ending. A failure fails
 * the webhook; the redelivery finds the order recorded but not synced and
 * tries again.
 */
async function syncIncreaseToPolar(
  account: CapacityAccount,
  orderId: string,
  subscriptionId: string,
  order: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("capacity_subscriptions")
    .select("*")
    .eq("polar_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) throw error;

  if (row?.status) {
    const polar = createPolarClient();
    const plan = await readAccount(account);
    // Blocks never outlive the plan, so they are kept only with a plan that goes on.
    const planGoesOn = plan?.plan_active === true && !plan.cancel_at_period_end;
    try {
      if (row.cancel_at_period_end && !row.canceled_with_plan && planGoesOn) {
        await polar.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
        await markSubscription(row.id, { cancel_at_period_end: false });
      }
      // Scheduled even for one set to end with the plan, so it renews with
      // the raised count if the plan is kept after all.
      await polar.subscriptions.update(subscriptionId, {
        units: row.units,
        proration_behavior: "next_period",
      });
      await markSubscription(row.id, { pending_units: row.units });
    } catch (polarError) {
      if (!isEndedSubscriptionError(polarError)) throw polarError;
      if (await hasEndedInPolar(subscriptionId)) {
        // Ended meanwhile (the order landed before the end's own event):
        // what the order added goes with it, and so does the row, whose
        // raised units would otherwise count until the end's own event.
        await settleEndedIncrease(account, orderId, order);
        await markEnded(account, row);
      } else if (!row.cancel_at_period_end) {
        // Only set to end in Polar (Polar refuses changes to one with the
        // same code): the units the order added count until its period end.
        await markSubscription(row.id, { cancel_at_period_end: true });
      }
    }
  } else {
    // Ended before this increase could ride on it (a redelivery after the
    // end's own event, or no row at all): what the order added is settled
    // as above, once.
    await settleEndedIncrease(account, orderId, order);
  }

  const { error: syncError } = await admin
    .from("capacity_purchases")
    .update({ synced_at: new Date().toISOString() })
    .eq("polar_order_id", orderId);
  if (syncError) throw syncError;
}

/**
 * A paid mid-period increase whose subscription ended before the increase
 * could ride on it. Blocks are kept as one-time blocks (recorded once, under
 * the order); domains have no one-time form, so the order is reported for a
 * refund, and the checkout link it came from is superseded like the other
 * domain refunds' links, so it never reads paid for a purchase undone.
 */
async function settleEndedIncrease(
  account: CapacityAccount,
  orderId: string,
  order: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: purchase, error } = await admin
    .from("capacity_purchases")
    .select("kind, units, polar_subscription_id")
    .eq("polar_order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!purchase) return;
  // The plan's reconcile may have kept the subscription's blocks, this
  // increase included, as one-time blocks already: nothing more to keep.
  if (purchase.polar_subscription_id) {
    const { data: kept, error: keptError } = await admin
      .from("capacity_purchases")
      .select("id")
      .eq("polar_order_id", `subscription:${purchase.polar_subscription_id}`)
      .maybeSingle();
    if (keptError) throw keptError;
    if (kept) return;
  }
  const credits: PurchaseKind | null =
    purchase.kind === "block_increase"
      ? "credits"
      : purchase.kind === "page_block_increase"
        ? "page_credits"
        : null;
  if (!credits) {
    // Domains have no one-time form to keep what was paid: it goes back.
    await refundFor(account, { order: orderId }, "addon_ended");
    await supersedeCheckoutLinks(
      asNonEmptyString(order.checkout_id),
      order.metadata,
      asNonEmptyString(order.customer_id)
    );
    return;
  }
  const { data: granted, error: grantError } = await admin.rpc("grant_capacity_purchase", {
    p_order_id: `increase:${orderId}`,
    ...accountIds(account),
    p_kind: credits,
    p_units: purchase.units,
    p_amount: null,
  });
  if (grantError) throw grantError;
  // The order was refunded meanwhile: nothing to keep.
  if ((granted as { status?: string } | null)?.status === "refunded") return;
  reportError(
    "[capacity] paid increase on blocks that ended was kept as one-time blocks",
    undefined,
    {
      orderId,
    }
  );
}

/**
 * Applies a Polar event for one of the add-on products. The caller has
 * already matched the product (capacityProductKind) and resolved the account
 * from the customer.
 */
export async function applyCapacityWebhookEvent(
  eventType: string,
  account: CapacityAccount,
  productKind: CapacityProductKind,
  data: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case "subscription.created":
    case "subscription.updated":
    case "subscription.active":
    case "subscription.canceled":
    case "subscription.uncanceled":
    case "subscription.past_due":
    case "subscription.cycled":
    case "subscription.revoked":
      if (productKind.kind === "monthly" || productKind.kind === "overage") {
        const spec = RESOURCES[productKind.resource];
        const kind = productKind.kind === "monthly" ? spec.blocks : spec.overage;
        if (kind) await applySubscriptionEvent(eventType, account, kind, data);
      }
      return;

    case "order.paid":
      if (productKind.kind === "one_time" || productKind.kind === "monthly_add") {
        await applyPaidOrder(account, productKind.resource, productKind.kind, data);
      }
      return;

    case "order.refunded": {
      const orderId = asNonEmptyString(data.id);
      if (!orderId || data.status !== "refunded") return;
      const admin = createAdminClient();
      const { data: result, error } = await admin.rpc("refund_capacity_purchase", {
        p_order_id: orderId,
      });
      if (error) throw error;
      const refunded = asRecord(result)?.kind;
      // Only an increase that raised a subscription still renewing changed
      // a renewal count anyone needs to look at.
      if (
        (refunded === "block_increase" ||
          refunded === "page_block_increase" ||
          refunded === "domain_increase") &&
        asRecord(result)?.subscription_live === true
      ) {
        reportError(
          "[capacity] refunded monthly blocks: check the renewal count in Polar",
          undefined,
          {
            orderId,
          }
        );
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// The plan's lifecycle
// ---------------------------------------------------------------------------

/** Records locally that an add-on has ended (its own revoke event may still be on the way). */
async function markEnded(account: CapacityAccount, row: CapacitySubscriptionRow): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("apply_capacity_subscription", {
    ...accountIds(account),
    p_kind: row.kind,
    p_subscription_id: row.polar_subscription_id,
    p_status: null,
    p_units: 0,
    p_pending_units: null,
    p_cancel_at_period_end: false,
    p_period_start: null,
    p_period_end: null,
  });
  if (error) throw error;
}

/**
 * Sets an add-on to end, or not, at its period end. One that has ended
 * already is recorded as ended instead of failing the webhook forever.
 */
async function setAddonEnding(
  account: CapacityAccount,
  row: CapacitySubscriptionRow,
  ending: boolean,
  withPlan: boolean
): Promise<void> {
  try {
    await createPolarClient().subscriptions.update(row.polar_subscription_id, {
      cancel_at_period_end: ending,
    });
  } catch (error) {
    if (!isEndedSubscriptionError(error)) throw error;
    if (await hasEndedInPolar(row.polar_subscription_id)) {
      await markEnded(account, row);
      return;
    }
    // Already set to end in Polar, which is what was asked; anything else
    // is unexpected.
    if (!ending) throw error;
  }
  await markSubscription(row.id, { cancel_at_period_end: ending, canceled_with_plan: withPlan });
}

/**
 * Whether an add-on Polar refused to change has really ended. Polar answers
 * AlreadyCanceledSubscription both for one that ended and for one only set
 * to end at its period end, which still counts until then.
 */
async function hasEndedInPolar(subscriptionId: string): Promise<boolean> {
  const subscription = await createPolarClient().subscriptions.get(subscriptionId);
  return addonStatus(subscription as unknown as Record<string, unknown>) === null;
}

/** The mid-period increase orders of an add-on's current period, not refunded. */
async function increaseOrders(row: CapacitySubscriptionRow): Promise<string[]> {
  let query = createAdminClient()
    .from("capacity_purchases")
    .select("polar_order_id")
    .eq("polar_subscription_id", row.polar_subscription_id)
    .is("refunded_at", null);
  if (row.period_start) query = query.gte("created_at", row.period_start);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((purchase) => purchase.polar_order_id);
}

/**
 * Brings the add-ons in line with the plan after any plan subscription
 * event (and after an add-on is bought), from the plan's stored state rather
 * than the event, so a stale or repeated event cannot end them by mistake:
 *
 * - plan live: add-ons that were ending only because the plan was come back;
 * - plan set to end: add-ons end with it (Polar would otherwise renew them);
 * - plan gone: blocks end now; overage, which stopped counting with the
 *   plan, ends at its period end, when Polar bills what was used, and does
 *   not come back with a later plan.
 *
 * Polar calls happen only where the two disagree, so repeats are cheap.
 */
export async function reconcileAddonsWithPlan(account: CapacityAccount): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("sync_capacity_account", accountIds(account));
  if (error) throw error;

  const rows = await liveSubscriptions(account);
  if (rows.length === 0) return;
  const plan = await readAccount(account);
  if (!plan) return;

  // Page and domain add-ons also end when the account leaves Business (or
  // the team leaves Team Business) at the renewal.
  const pagesLeaving = plan.pages_ending;
  const domainsLeaving = plan.domains_ending;

  for (const row of rows) {
    // Page and domain add-ons need Business (or Team Business); the rest the plan.
    // A complimentary (staff) team has no plan subscription for add-ons to
    // go with, so its add-ons end as they would with the plan gone.
    const active =
      !plan.complimentary &&
      (PAGE_KINDS.has(row.kind)
        ? plan.pages_active
        : DOMAIN_KINDS.has(row.kind)
          ? plan.domains_active
          : plan.plan_active);
    const leaving =
      plan.cancel_at_period_end ||
      (PAGE_KINDS.has(row.kind) && pagesLeaving) ||
      (DOMAIN_KINDS.has(row.kind) && domainsLeaving);
    if (!active) {
      // The plan is gone, not merely ending: a later plan is a new decision,
      // so nothing here is marked to come back with it.
      if (BLOCK_KINDS.has(row.kind)) {
        // Paid-up blocks that were going to renew lost a period they paid
        // for (the plan was revoked mid-period, or they were bought just
        // after it ended): what was paid stays as one-time blocks. Blocks
        // ending with the plan at the same renewal lost nothing, and blocks
        // behind on payment were not paid for. Granted first, while the row
        // is still live, so a failure here is retried with the webhook.
        if (!row.cancel_at_period_end && row.status === "active" && row.units > 0) {
          const credits = creditsFor(row.kind);
          if (credits) {
            await keepAsOneTimeBlocks(account, row.polar_subscription_id, row.units, null, credits);
          } else {
            reportError(
              "[capacity] paid extra domains ended with the plan; refund them",
              undefined,
              {
                subscriptionId: row.polar_subscription_id,
                // Domains added this period were separate orders.
                orderIds: (await increaseOrders(row)).join(",") || undefined,
              }
            );
          }
        }
        await revokeQuietly(row.polar_subscription_id);
        await markEnded(account, row);
      } else if (!row.cancel_at_period_end) {
        await setAddonEnding(account, row, true, false);
      } else if (row.canceled_with_plan) {
        await markSubscription(row.id, { canceled_with_plan: false });
      }
    } else if (leaving) {
      // An annual plan's add-ons renew monthly: each ends in the month its
      // next renewal would pass the plan's end, decided from its own period
      // (just written by its renewal) and checked again at each renewal.
      const lastRenewal =
        plan.annual_end === null || endsBeforeNextWindow(plan.annual_end, row.period_end);
      if (!row.cancel_at_period_end && lastRenewal) {
        await setAddonEnding(account, row, true, true);
      }
    } else if (row.cancel_at_period_end && row.canceled_with_plan) {
      await setAddonEnding(account, row, false, false);
    }
  }
}

/**
 * Ends every add-on subscription now, for account and team deletion: their
 * rows go with the account, and nothing would be left to stop Polar charging.
 * Throws when one cannot be ended, so the deletion can stop and be retried.
 */
export async function revokeAllAddons(account: CapacityAccount): Promise<void> {
  for (const row of await liveSubscriptions(account)) {
    await revokeQuietly(row.polar_subscription_id);
  }
}
