import {
  BLOCK_PAGES,
  BLOCK_REQUESTS,
  DEFAULT_OVERAGE_MAX_REQUESTS,
  DEFAULT_PAGE_OVERAGE_MAX_PAGES,
  MAX_BLOCKS,
  MAX_PAGE_BLOCKS,
  periodOverageUsed,
} from "@/lib/capacity";
import { publicEnv } from "@/lib/env";
import {
  configuredCapacityProductIds,
  configuredPageProductIds,
  createPolarClient,
  getCapacityProductIds,
  getPageProductIds,
  isEndedSubscriptionError,
  loggablePolarError,
  teamBusinessProductId,
  type CapacityProductIds,
} from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { planEntitlements, teamEntitlements } from "@/lib/entitlements";
import { createAdminClient } from "./admin";
import { ensurePolarCustomerId, getBillingUser } from "./billing";
import { asNonEmptyString, asRecord, parseEventTimestamp } from "./billing-shared";
import type { Database } from "./database";
import { ensureTeamPolarCustomerId, getTeamForOwner } from "./team-billing";

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
 * Business accounts and teams with Team Business: the same functions with
 * `resource: "pages"`. The Team Business add-on is a monthly subscription
 * on the team's customer, aligned and ended with the team's plan the same
 * way; while it is live the team is a Business team (sync_capacity_account).
 *
 * Polar's subscription events for these products never reach the plan
 * handlers: the webhook routes them here by product.
 */

export type CapacityAccount = { kind: "user"; userId: string } | { kind: "team"; teamId: string };

type CapacitySubscriptionRow = Database["public"]["Tables"]["capacity_subscriptions"]["Row"];
type CapacityKind = CapacitySubscriptionRow["kind"];

type PurchaseKind = Database["public"]["Tables"]["capacity_purchases"]["Row"]["kind"];

/** What an add-on adds to: the request quota or the parsed pages. */
export type CapacityResource = "requests" | "pages";

/** An add-on product, as the webhook routes it. */
export type CapacityProductKind =
  | { resource: CapacityResource; kind: "one_time" | "monthly" | "monthly_add" | "overage" }
  | { resource: "team"; kind: "team_business" };

interface ResourceSpec {
  /** The recurring blocks' and overage's subscription kinds. */
  blocks: CapacityKind;
  overage: CapacityKind;
  /** One-time blocks, and blocks added to the subscription mid-period. */
  credits: PurchaseKind;
  increase: PurchaseKind;
  blockSize: number;
  maxBlocks: number;
  defaultOverageMax: number;
  /** Where the account page shows them. */
  anchor: string;
  products: () => CapacityProductIds | null;
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
    anchor: "extra-pages",
    products: getPageProductIds,
    noun: "parsed pages",
  },
};

const PAGE_KINDS = new Set<CapacityKind>(["page_blocks", "page_overage"]);
const BLOCK_KINDS = new Set<CapacityKind>(["blocks", "page_blocks"]);

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

export interface CapacityState {
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
  /** The plan's own requests per period. */
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
  /** Page add-ons count: Business, or a team with Team Business, on a live plan. */
  pages_active: boolean;
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
  "polar_customer_id, cancel_at_period_end, requests_used, request_limit, block_requests, credit_requests, overage_active, overage_max, overage_used, overage_period_start, period_start, period_end, credit_pages, page_block_pages, page_overage_active, page_overage_max";

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
      .select(`${ACCOUNT_COLUMNS}, subscription_status, business`)
      .eq("id", account.teamId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const live = data.subscription_status !== null;
    return {
      ...data,
      plan_active: live,
      pages_active: live && data.business,
      plan_pages: teamEntitlements(data.business).parsedPages,
    };
  }

  const { data, error } = await admin
    .from("users")
    .select(`${ACCOUNT_COLUMNS}, plan, subscription_status`)
    .eq("id", account.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const entitlements = planEntitlements(data.plan);
  return {
    ...data,
    plan_active: entitlements.requestAddons && data.subscription_status !== null,
    pages_active: entitlements.pageAddons && data.subscription_status !== null,
    plan_pages: entitlements.parsedPages,
  };
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

function successUrl(account: CapacityAccount, what: string, anchor = "extra-requests"): string {
  const appUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  return account.kind === "team"
    ? `${appUrl}/teams/${account.teamId}?capacity=${what}#${anchor}`
    : `${appUrl}/account/plan?capacity=${what}#${anchor}`;
}

function requireProducts(resource: CapacityResource = "requests") {
  const products = RESOURCES[resource].products();
  if (!products) {
    throw new CapacityError(
      "not_offered",
      resource === "pages"
        ? "Extra parsed pages are not available yet"
        : "Extra requests are not available yet",
      404
    );
  }
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
  if (resource === "pages" && !row.pages_active) {
    throw new CapacityError(
      "plan_required",
      account.kind === "team"
        ? "Extra parsed pages come with Team Business. Add it to the team first."
        : "Extra parsed pages are part of Business. Upgrade first."
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
  if (renewing && row.cancel_at_period_end) {
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
  if (resource === "pages") return pageState(account, row);
  const subscriptions = await liveSubscriptions(account);
  const blocks = liveOfKind(subscriptions, "blocks");
  const overage = liveOfKind(subscriptions, "overage");

  return {
    offered: getCapacityProductIds() !== null,
    eligible: row.plan_active,
    planEnding: row.plan_active && row.cancel_at_period_end,
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
async function pageState(account: CapacityAccount, row: AccountRow): Promise<CapacityState> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("parsed_pages_balance", accountIds(account));
  if (error) throw error;
  const balance = (Array.isArray(data) ? data[0] : data) as {
    window_start: string | null;
    allowance: number;
    used: number;
    credits: number;
    overage_left: number;
  } | null;
  const subscriptions = await liveSubscriptions(account);
  const blocks = liveOfKind(subscriptions, "page_blocks");
  const overage = liveOfKind(subscriptions, "page_overage");
  const overageMax = row.page_overage_max;
  return {
    offered: getPageProductIds() !== null,
    eligible: row.pages_active,
    planEnding: row.pages_active && row.cancel_at_period_end,
    periodStart: balance?.window_start ?? row.period_start,
    periodEnd: row.period_end,
    planRequests: row.plan_pages,
    blockRequests: row.page_block_pages,
    used: Number(balance?.used ?? 0),
    creditRequests: Number(row.credit_pages),
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
      usedRequests: Math.max(overageMax - Number(balance?.overage_left ?? overageMax), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Customer actions
// ---------------------------------------------------------------------------

/** A checkout for one-time blocks. */
export async function createOneTimeBlocksCheckout(
  account: CapacityAccount,
  actingUserId: string,
  blocks: number,
  resource: CapacityResource = "requests"
): Promise<string> {
  const spec = RESOURCES[resource];
  const products = requireProducts(resource);
  await requireEligible(account, { resource });
  const customerId = await ensureCustomer(account, actingUserId);

  const checkout = await createPolarClient().checkouts.create({
    products: [products.oneTime],
    units: blocks,
    min_units: 1,
    max_units: spec.maxBlocks,
    customer_id: customerId,
    success_url: successUrl(account, "blocks", spec.anchor),
    metadata: { capacity: "one_time", resource },
  });
  return checkout.url;
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
  resource: CapacityResource = "requests"
): Promise<MonthlyBlocksResult> {
  const spec = RESOURCES[resource];
  const products = requireProducts(resource);
  // Ending them never needs the plan.
  if (blocks > 0) await requireEligible(account, { renewing: true, resource });
  const current = liveOfKind(await liveSubscriptions(account), spec.blocks);
  const polar = createPolarClient();

  if (!current) {
    if (blocks === 0) return { kind: "unchanged" };
    const customerId = await ensureCustomer(account, actingUserId);
    const checkout = await polar.checkouts.create({
      products: [products.monthly],
      units: blocks,
      min_units: 1,
      max_units: spec.maxBlocks,
      customer_id: customerId,
      success_url: successUrl(account, "monthly", spec.anchor),
      metadata: { capacity: "monthly", resource },
    });
    return { kind: "checkout", url: checkout.url };
  }

  if (current.status === "past_due") {
    throw new CapacityError(
      "past_due",
      "The last payment for your monthly blocks failed. Update your card from the Polar receipt email first."
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
    const customerId = await ensureCustomer(account, actingUserId);
    const checkout = await polar.checkouts.create({
      products: [products.monthlyAdd],
      units: blocks - current.units,
      min_units: blocks - current.units,
      max_units: blocks - current.units,
      customer_id: customerId,
      success_url: successUrl(account, "monthly", spec.anchor),
      metadata: {
        capacity: "monthly_add",
        resource,
        subscription_id: current.polar_subscription_id,
      },
    });
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
  const current = liveOfKind(await liveSubscriptions(account), spec.overage);
  const polar = createPolarClient();

  if (!options.enabled) {
    await writeOverageMax(account, 0, resource);
    if (current && !current.cancel_at_period_end) {
      await polar.subscriptions.update(current.polar_subscription_id, {
        cancel_at_period_end: true,
      });
      await markSubscription(current.id, { cancel_at_period_end: true, canceled_with_plan: false });
    }
    return { kind: "updated" };
  }

  const row = await requireEligible(account, { renewing: true, resource });
  const storedMax = resource === "pages" ? row.page_overage_max : row.overage_max;
  const maxRequests = options.maxRequests ?? (storedMax > 0 ? storedMax : spec.defaultOverageMax);
  if (
    !Number.isInteger(maxRequests) ||
    maxRequests <= 0 ||
    maxRequests % spec.blockSize !== 0 ||
    maxRequests > spec.maxBlocks * spec.blockSize
  ) {
    throw new CapacityError(
      "invalid_max",
      `The maximum must be a whole number of ${spec.blockSize.toLocaleString("en-US")} blocks`,
      400
    );
  }
  if (current?.status === "past_due") {
    throw new CapacityError(
      "past_due",
      "The last overage payment failed. Update your card from the Polar receipt email first."
    );
  }
  await writeOverageMax(account, maxRequests, resource);

  if (!current) {
    const customerId = await ensureCustomer(account, actingUserId);
    const checkout = await polar.checkouts.create({
      products: [products.overage],
      customer_id: customerId,
      success_url: successUrl(account, "overage", spec.anchor),
      metadata: { capacity: "overage", resource },
    });
    return { kind: "checkout", url: checkout.url };
  }

  if (current.cancel_at_period_end) {
    await polar.subscriptions.update(current.polar_subscription_id, {
      cancel_at_period_end: false,
    });
    await markSubscription(current.id, { cancel_at_period_end: false, canceled_with_plan: false });
  }
  return { kind: "updated" };
}

async function writeOverageMax(
  account: CapacityAccount,
  max: number,
  resource: CapacityResource = "requests"
): Promise<void> {
  const admin = createAdminClient();
  const patch = resource === "pages" ? { page_overage_max: max } : { overage_max: max };
  const { error } =
    account.kind === "team"
      ? await admin.from("teams").update(patch).eq("id", account.teamId)
      : await admin.from("users").update(patch).eq("id", account.userId);
  if (error) throw error;
}

/**
 * Adds Team Business to a subscribed team: a checkout for the add-on on the
 * team's customer. Bought mid-period it is charged in full and its first
 * period ends with the team's (alignWithPlan), and it counts at once.
 */
export async function createTeamBusinessCheckout(
  account: Extract<CapacityAccount, { kind: "team" }>,
  actingUserId: string
): Promise<string> {
  const productId = teamBusinessProductId();
  if (!productId) {
    throw new CapacityError("not_offered", "Team Business is not available yet", 404);
  }
  await requireEligible(account, { renewing: true });
  if (liveOfKind(await liveSubscriptions(account), "team_business")) {
    throw new CapacityError("already_business", "The team already has Team Business");
  }
  const customerId = await ensureCustomer(account, actingUserId);
  const checkout = await createPolarClient().checkouts.create({
    products: [productId],
    customer_id: customerId,
    success_url: successUrl(account, "business", "team-business"),
    metadata: { capacity: "team_business" },
  });
  return checkout.url;
}

/** Ends Team Business at the period end, or keeps it when it was set to end. */
export async function setTeamBusinessEnding(
  account: Extract<CapacityAccount, { kind: "team" }>,
  ending: boolean
): Promise<void> {
  const current = liveOfKind(await liveSubscriptions(account), "team_business");
  if (!current) throw new CapacityError("not_found", "The team has no Team Business", 404);
  if (!ending) await requireEligible(account, { renewing: true });
  await setAddonEnding(account, current, ending, false);
}

/**
 * Sets the account's page add-ons to end with its period: a plan change
 * away from Business takes effect at the renewal, and they renew with it.
 */
export async function endPageAddonsWithPeriod(account: CapacityAccount): Promise<void> {
  for (const row of await liveSubscriptions(account)) {
    if (PAGE_KINDS.has(row.kind) && !row.cancel_at_period_end) {
      await setAddonEnding(account, row, true, false);
    }
  }
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
  if (productId === teamBusinessProductId()) return { resource: "team", kind: "team_business" };
  for (const [resource, products] of [
    ["requests", configuredCapacityProductIds()],
    ["pages", configuredPageProductIds()],
  ] as const) {
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

/**
 * Moves an add-on's renewal onto the plan's, so blocks and overage renew and
 * bill together with the plan. Only ever earlier: a later end would give the
 * add-on time nobody paid for, and when the plan has just renewed, the
 * add-on's own renewal may simply not have been processed yet. Bought
 * mid-period, an add-on's first period ends with the plan's (the customer
 * pays the full price for it, by choice). Best effort: the add-on's next
 * event tries again.
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
  if (planEndMs < Date.now() + 2 * 60_000 || addonEndMs - planEndMs < 60_000) return;

  try {
    await createPolarClient().subscriptions.update(subscriptionId, {
      current_billing_period_end: new Date(planEndMs).toISOString(),
    });
  } catch (error) {
    reportError("[capacity] failed to align an add-on with the plan", loggablePolarError(error), {
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

  const status = await applySubscriptionState(account, kind, subscription, ended);

  if (status === "duplicate") {
    await settleDuplicate(account, kind, subscription);
    return;
  }

  if (status === "no_account") {
    // The account or team is gone (deleted while a checkout was open):
    // nothing may keep charging for it.
    await revokeQuietly(subscriptionId);
    reportError("[capacity] add-on subscription for a deleted account was ended", undefined, {
      subscriptionId,
    });
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

async function revokeQuietly(subscriptionId: string): Promise<void> {
  try {
    await createPolarClient().subscriptions.revoke(subscriptionId);
  } catch (error) {
    if (!isEndedSubscriptionError(error)) throw error;
  }
}

/**
 * A second subscription of a kind the account already has (a checkout
 * completed twice). Overage has charged nothing yet, so it simply ends.
 * Paid blocks end too, and what was paid for them is kept as one-time
 * blocks, recorded once under the subscription's id, so nothing keeps
 * charging and nothing paid for is lost.
 */
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
  if (BLOCK_KINDS.has(kind) && units >= 1) {
    await keepAsOneTimeBlocks(
      account,
      subscriptionId,
      units,
      typeof subscription.amount === "number" ? subscription.amount : null,
      kind === "page_blocks" ? "page_credits" : "credits"
    );
  }
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

  const admin = createAdminClient();
  const { data: result, error } = await admin.rpc("grant_capacity_purchase", {
    p_order_id: orderId,
    ...accountIds(account),
    p_kind: productKind === "one_time" ? spec.credits : spec.increase,
    p_units: units,
    p_amount: typeof data.total_amount === "number" ? data.total_amount : null,
  });
  if (error) throw error;

  const granted = asRecord(result);
  if (granted?.status === "no_account") {
    reportError("[capacity] paid order for a deleted account: refund it", undefined, { orderId });
    return;
  }
  if (granted?.kind !== spec.increase || granted.synced === true) return;
  const subscriptionId = asNonEmptyString(granted.subscription_id);
  if (!subscriptionId) return;
  await syncIncreaseToPolar(account, orderId, subscriptionId);
  // The plan may have been set to end since the checkout was opened.
  await reconcileAddonsWithPlan(account);
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
  subscriptionId: string
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
      await polar.subscriptions.update(subscriptionId, {
        units: row.units,
        proration_behavior: "next_period",
      });
      await markSubscription(row.id, { pending_units: row.units });
    } catch (polarError) {
      // Ended meanwhile: there is no renewal left to raise.
      if (!isEndedSubscriptionError(polarError)) throw polarError;
    }
  }

  const { error: syncError } = await admin
    .from("capacity_purchases")
    .update({ synced_at: new Date().toISOString() })
    .eq("polar_order_id", orderId);
  if (syncError) throw syncError;
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
      if (productKind.resource === "team") {
        await applySubscriptionEvent(eventType, account, "team_business", data);
      } else if (productKind.kind === "monthly" || productKind.kind === "overage") {
        const spec = RESOURCES[productKind.resource];
        await applySubscriptionEvent(
          eventType,
          account,
          productKind.kind === "monthly" ? spec.blocks : spec.overage,
          data
        );
      }
      return;

    case "order.paid":
      if (
        productKind.resource !== "team" &&
        (productKind.kind === "one_time" || productKind.kind === "monthly_add")
      ) {
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
      if (refunded === "block_increase" || refunded === "page_block_increase") {
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
    await markEnded(account, row);
    return;
  }
  await markSubscription(row.id, { cancel_at_period_end: ending, canceled_with_plan: withPlan });
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

  for (const row of rows) {
    // Page add-ons need Business (or Team Business); the rest the plan.
    const active = PAGE_KINDS.has(row.kind) ? plan.pages_active : plan.plan_active;
    if (!active) {
      // The plan is gone, not merely ending: a later plan is a new decision,
      // so nothing here is marked to come back with it.
      if (row.kind === "team_business") {
        // It is the team's plan's add-on: nothing to keep once that is gone.
        await revokeQuietly(row.polar_subscription_id);
        await markEnded(account, row);
      } else if (BLOCK_KINDS.has(row.kind)) {
        // Paid-up blocks that were going to renew lost a period they paid
        // for (the plan was revoked mid-period, or they were bought just
        // after it ended): what was paid stays as one-time blocks. Blocks
        // ending with the plan at the same renewal lost nothing, and blocks
        // behind on payment were not paid for. Granted first, while the row
        // is still live, so a failure here is retried with the webhook.
        if (!row.cancel_at_period_end && row.status === "active" && row.units > 0) {
          await keepAsOneTimeBlocks(
            account,
            row.polar_subscription_id,
            row.units,
            null,
            row.kind === "page_blocks" ? "page_credits" : "credits"
          );
        }
        await revokeQuietly(row.polar_subscription_id);
        await markEnded(account, row);
      } else if (!row.cancel_at_period_end) {
        await setAddonEnding(account, row, true, false);
      } else if (row.canceled_with_plan) {
        await markSubscription(row.id, { canceled_with_plan: false });
      }
    } else if (plan.cancel_at_period_end) {
      if (!row.cancel_at_period_end) {
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
