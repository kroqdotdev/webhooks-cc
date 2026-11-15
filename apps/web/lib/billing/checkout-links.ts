/**
 * Checkout links (migration 00104): an API key, a claimed agent or a
 * session asks for something the account can buy and hands the person a
 * link to our own page, /checkout/{id}. Nothing is charged until the person
 * pays on Polar's page with their own card, so no approval is asked for; the
 * customer portal, plan changes and cancelling stay with a session.
 *
 * Making a link checks the purchase (who may buy, what the account has, the
 * limits), audits it and stores the row, and touches nothing in Polar. The
 * page needs the billing account owner's session (the team's owner for a
 * team), past two-factor sign-in when the account has it. Opening it checks
 * the purchase again, makes the Polar checkout session (a team's through
 * the dashboard's one open session) and sends the person on to Polar; a
 * reopen reuses the session while Polar still has it open and it still
 * sells what the purchase check asks for now. The page shows what the link
 * buys, who asked and from where first (reviewCheckoutLink(), which makes
 * nothing), and opens it only when the person continues. Polar's link,
 * and its session id, never reach a key holder: the API answers our link,
 * the status and what it buys.
 *
 * What a link can buy mirrors what the dashboard's checkout routes start
 * (a plan, a team subscription, one-time and monthly blocks, overage), and
 * goes through the same rules (the *Purchase() functions beside them). A
 * link's own session sells one product and exactly its seats or units; a
 * team link that reuses or moves the dashboard's open session does not, so
 * a paid link records what was bought (`bought`) and says whether it
 * `matches` what the link asked for.
 *
 * Rails: a pre-claim agent token (no user) is refused by the route's auth;
 * a team purchase needs the team's owner; reserve_billing_checkout() holds
 * each billing account to 5 links an hour and 3 open at once.
 */
import { z } from "zod";
import { PLAN_PRICES } from "@/lib/plan-prices";
import {
  MAX_BLOCKS,
  MAX_EXTRA_DOMAINS,
  MAX_PAGE_BLOCKS,
  MONTHLY_BLOCK_CENTS,
  MONTHLY_DOMAIN_CENTS,
  MONTHLY_PAGE_BLOCK_CENTS,
  ONE_TIME_BLOCK_CENTS,
  ONE_TIME_PAGE_BLOCK_CENTS,
  OVERAGE_BLOCK_CENTS,
  PAGE_OVERAGE_CENTS,
} from "@/lib/capacity";
import { checkoutLinkNamedBy } from "@/lib/billing/checkout-link-rows";
import { compareNetworks, type NetworkMatch } from "@/lib/device-requester";
import { cleanUntrustedName } from "@/lib/untrusted-name";
import { createPolarClient, loggablePolarError } from "@/lib/polar";
import { formatCents, formatSeatPricing, MIN_TEAM_SEATS, MAX_TEAM_SEATS } from "@/lib/team-pricing";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingActionError, planPurchase } from "@/lib/supabase/billing";
import { accountHomeOrigin } from "@/lib/supabase/home-site";
import {
  asNonEmptyString,
  asRecord,
  isLiveSubscription,
  type CheckoutExpected,
  type LinkPurchase,
} from "@/lib/supabase/billing-shared";
import {
  assertCanManage,
  CapacityError,
  monthlyBlocksPurchase,
  oneTimeBlocksPurchase,
  overagePurchase,
  type CapacityAccount,
} from "@/lib/supabase/capacity-billing";
import type {
  BillingCheckoutKind,
  BillingCheckoutStatus,
  Database,
  Json,
} from "@/lib/supabase/database";
import { getTeamForOwner, TeamBillingError, teamPlanPurchase } from "@/lib/supabase/team-billing";

/** The public page Polar sends the person to after paying. */
export const CHECKOUT_COMPLETE_PATH = "/checkout/complete";
/** At most this many links per billing account in an hour (the migration holds it). */
export const CHECKOUT_LINKS_PER_HOUR = 5;
/** At most this many links open at once per billing account (the migration holds it). */
export const CHECKOUT_LINKS_OPEN = 3;
/**
 * At most this many attempts an hour per asking person, refused and failed
 * ones included (the route holds it): those make no link, so the hourly
 * limit on links never sees them.
 */
export const CHECKOUT_ATTEMPTS_PER_HOUR = 30;
/** A read past expiry asks Polar about the session at most this often. */
export const POLAR_CHECK_INTERVAL_MS = 30_000;
/** How long one tab may take to make the Polar session before another may. */
const OPENING_LEASE_MS = 30_000;
/** Polar's checkouts expire after an hour; used when one comes back without its expiry. */
const FALLBACK_EXPIRY_MS = 60 * 60_000;

type Row = Database["public"]["Tables"]["billing_checkouts"]["Row"];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
  message: "must be a team id",
});
const interval = z.enum(["month", "year"]).default("month");

const planItem = z.strictObject({
  kind: z.literal("plan"),
  plan: z.enum(["pro", "business"]),
  interval,
});
const teamPlanItem = z.strictObject({
  kind: z.literal("team_plan"),
  teamId: uuid,
  seats: z.number().int().min(MIN_TEAM_SEATS).max(MAX_TEAM_SEATS),
  plan: z.enum(["team", "team_business"]).default("team"),
  interval,
});
const blocksItem = z.strictObject({
  kind: z.literal("blocks"),
  blocks: z.number().int().min(1),
  resource: z.enum(["requests", "pages"]).default("requests"),
  teamId: uuid.optional(),
});
const monthlyBlocksItem = z.strictObject({
  kind: z.literal("monthly_blocks"),
  blocks: z.number().int().min(1),
  resource: z.enum(["requests", "pages", "domains"]).default("requests"),
  teamId: uuid.optional(),
});
const overageItem = z.strictObject({
  kind: z.literal("overage"),
  resource: z.enum(["requests", "pages"]).default("requests"),
  teamId: uuid.optional(),
});

/** What a link can buy, as POST /api/billing/checkouts takes it. */
const itemSchema = z.discriminatedUnion("kind", [
  planItem,
  teamPlanItem,
  blocksItem,
  monthlyBlocksItem,
  overageItem,
]);

/**
 * An item as a link stores it: an overage link also keeps the maximum it
 * was made with (the account's stored one, else the default), which its
 * summary names and its subscription is given when it arrives.
 */
const storedItemSchema = z.discriminatedUnion("kind", [
  planItem,
  teamPlanItem,
  blocksItem,
  monthlyBlocksItem,
  overageItem.extend({ max: z.number().int().positive().optional() }),
]);

export type CheckoutItem = z.infer<typeof itemSchema>;
/** An item as a link stores it (an overage link with its maximum). */
export type StoredCheckoutItem = z.infer<typeof storedItemSchema>;

const MAX_UNITS = { requests: MAX_BLOCKS, pages: MAX_PAGE_BLOCKS, domains: MAX_EXTRA_DOMAINS };

/** The item a request body names, or why it names none. */
export function parseCheckoutItem(
  body: unknown
): { ok: true; item: CheckoutItem } | { ok: false; error: string } {
  const parsed = itemSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      error: `${where}${issue?.message ?? "invalid body"}. kind is one of plan, team_plan, blocks, monthly_blocks, overage.`,
    };
  }
  const item = parsed.data;
  if (item.kind === "blocks" || item.kind === "monthly_blocks") {
    const max = MAX_UNITS[item.resource];
    if (item.blocks > max) return { ok: false, error: `blocks: at most ${max}` };
  }
  return { ok: true, item };
}

/** The team an item is for, or null for the person's own account. */
export function itemTeamId(item: StoredCheckoutItem): string | null {
  return "teamId" in item && item.teamId ? item.teamId : null;
}

const NOUNS = {
  requests: ["block of 25,000 requests", "blocks of 25,000 requests"],
  pages: ["block of 1,000 parsed pages", "blocks of 1,000 parsed pages"],
  domains: ["extra custom domain", "extra custom domains"],
} as const;

/**
 * One sentence that says what the link buys, for the asker and the person.
 * `have`, when known (the checkout page reads it), is the monthly blocks the
 * account has now, so a top-up reads as what it adds.
 */
export function checkoutSummary(item: StoredCheckoutItem, have = 0): string {
  const per = (i: "month" | "year") => (i === "year" ? "billed yearly" : "billed monthly");
  const team = itemTeamId(item) ? "the team" : "the account";
  switch (item.kind) {
    case "plan":
      return `The ${item.plan === "pro" ? "Pro" : "Business"} plan, ${per(item.interval)}.`;
    case "team_plan":
      return `${item.plan === "team" ? "Teams" : "Team Business"} for the team, ${item.seats} seats, ${per(item.interval)}.`;
    case "blocks": {
      const [one, many] = NOUNS[item.resource];
      return `${item.blocks} one-time ${item.blocks === 1 ? one : many} for ${team}; they never expire.`;
    }
    case "monthly_blocks": {
      const [one, many] = NOUNS[item.resource];
      const added = item.blocks - have;
      if (have > 0 && added > 0) {
        const holder = itemTeamId(item) ? "the team has" : "you have";
        return `${added} monthly ${added === 1 ? one : many} added to the ${have} ${holder}, renewing with the plan.`;
      }
      return `${item.blocks} monthly ${item.blocks === 1 ? one : many} in all for ${team}, renewing with the plan.`;
    }
    case "overage": {
      const noun = item.resource === "pages" ? "parsed pages" : "requests";
      const max =
        "max" in item && typeof item.max === "number"
          ? `up to ${item.max.toLocaleString("en-US")} ${noun} a month`
          : "up to its monthly maximum";
      return `Overage for ${team}'s ${noun}, billed for what is used past the plan, ${max}.`;
    }
  }
}

/** What a paid link's order or subscription holds, as Polar reported it. */
export interface CheckoutBought {
  product: string | null;
  seats: number | null;
  units: number | null;
  /** In cents, before tax. */
  amount: number | null;
  currency: string | null;
}

/**
 * A checkout link as the API answers it. `url` is our page, only while the
 * link is open; Polar's checkout never appears. `bought` and `matches` are
 * set once it is paid: whether what was bought is what the link asked for.
 */
export interface CheckoutLinkView {
  id: string;
  status: BillingCheckoutStatus;
  kind: BillingCheckoutKind;
  summary: string;
  item: StoredCheckoutItem;
  teamId: string | null;
  url: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  bought: CheckoutBought | null;
  matches: boolean | null;
}

/** Who asked: the person, and the key or agent registration they asked with. */
export interface CheckoutAsker {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
  /** The /24 or /48 the request came from (networkOf()), for the page's warning. */
  network?: string | null;
  /** Cloudflare's country for the request. */
  country?: string | null;
}

/** A refusal the routes answer as is, with its status. */
export class CheckoutLinkError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CheckoutLinkError";
    this.code = code;
    this.status = status;
  }
}

function storedItem(row: Row): StoredCheckoutItem {
  const parsed = storedItemSchema.safeParse(row.item);
  return parsed.success ? parsed.data : (row.item as unknown as StoredCheckoutItem);
}

function asExpected(value: Json | null): CheckoutExpected | null {
  const record = asRecord(value);
  const product = record ? asNonEmptyString(record.product) : null;
  if (!record || !product) return null;
  return {
    product,
    ...(typeof record.seats === "number" ? { seats: record.seats } : {}),
    ...(typeof record.units === "number" ? { units: record.units } : {}),
  };
}

function asBought(value: Json | null): CheckoutBought | null {
  const record = asRecord(value);
  if (!record) return null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    product: asNonEmptyString(record.product),
    seats: num(record.seats),
    units: num(record.units),
    amount: num(record.amount),
    currency: asNonEmptyString(record.currency),
  };
}

/**
 * Whether what was bought is what the session was meant to sell: the
 * product, and the seats or units where the link names them. Null when
 * either side is unknown.
 */
export function boughtMatches(
  expected: CheckoutExpected | null,
  bought: CheckoutBought | null
): boolean | null {
  if (!expected || !bought || !bought.product) return null;
  if (bought.product !== expected.product) return false;
  if (expected.seats !== undefined && bought.seats !== expected.seats) return false;
  if (expected.units !== undefined && bought.units !== expected.units) return false;
  return true;
}

function view(row: Row): CheckoutLinkView {
  const item = storedItem(row);
  const bought = asBought(row.bought);
  const paid = row.status === "paid" || row.status === "superseded";
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    summary: checkoutSummary(item),
    item,
    teamId: row.team_id,
    // Past its expiry an open link is being settled (from Polar, at most
    // every 30 seconds): never handed out again.
    url: row.status === "open" && !isPastExpiry(row) ? row.url : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    bought: paid ? bought : null,
    // A mismatch the webhook recorded (a top-up paid on another base) is
    // one the order itself cannot show.
    matches: paid ? (row.mismatch ? false : boughtMatches(asExpected(row.expected), bought)) : null,
  };
}

function capacityAccount(item: StoredCheckoutItem, userId: string): CapacityAccount {
  const teamId = itemTeamId(item);
  return teamId ? { kind: "team", teamId } : { kind: "user", userId };
}

/**
 * The purchase an item is, checked for the person buying it (the account's
 * user, or the team's owner): the same functions and rules the dashboard's
 * checkouts use. Throws their BillingActionError, TeamBillingError or
 * CapacityError when it cannot be bought.
 */
async function purchaseFor(
  item: StoredCheckoutItem,
  userId: string
): Promise<LinkPurchase & { max?: number; have?: number }> {
  switch (item.kind) {
    case "plan":
      return planPurchase(userId, item.plan, item.interval);
    case "team_plan":
      return teamPlanPurchase(userId, item.teamId, item.seats, item.plan, item.interval);
    case "blocks":
      return oneTimeBlocksPurchase(
        capacityAccount(item, userId),
        userId,
        item.blocks,
        item.resource
      );
    case "monthly_blocks":
      return monthlyBlocksPurchase(
        capacityAccount(item, userId),
        userId,
        item.blocks,
        item.resource
      );
    case "overage":
      return overagePurchase(
        capacityAccount(item, userId),
        userId,
        item.resource,
        "max" in item ? item.max : undefined
      );
  }
}

const COLUMNS =
  "id, user_id, team_id, created_by, requested_by_key, requested_by_agent, network, country, kind, item, url, polar_checkout_id, previous_checkout_ids, expected, bought, mismatch, detached_at, cancelled_at, opening_at, polar_checked_at, status, created_at, expires_at, paid_at";

/**
 * Checks the purchase and makes the link (the limits). Nothing in Polar is
 * touched: the session is made when the person opens the link. Throws
 * CheckoutLinkError for the limits, and the purchase checks' own errors
 * (BillingActionError, TeamBillingError, CapacityError) for the routes to
 * answer.
 */
export async function createCheckoutLink(
  asker: CheckoutAsker,
  item: CheckoutItem
): Promise<CheckoutLinkView> {
  const admin = createAdminClient();
  const teamId = itemTeamId(item);
  // A member's key never makes a link for the team: only its owner may buy
  // for it, and the purchase checks say so.
  const purchase = await purchaseFor(item, asker.userId);
  const stored: StoredCheckoutItem =
    item.kind === "overage" && purchase.max !== undefined ? { ...item, max: purchase.max } : item;
  // The link is on the site its asker uses. For a team the asker is its
  // owner (checked above), who is the one to open it.
  const origin = await accountHomeOrigin(asker.userId);

  const { data: id, error: reserveError } = await admin.rpc("reserve_billing_checkout", {
    p_user_id: teamId ? null : asker.userId,
    p_team_id: teamId,
    p_created_by: asker.userId,
    p_key_id: asker.keyId ?? null,
    p_agent_id: asker.agentRegistrationId ?? null,
    p_kind: item.kind,
    p_item: stored as unknown as Json,
    p_origin: origin,
    p_network: asker.network ?? null,
    p_country: asker.country ?? null,
  });
  if (reserveError) {
    if (reserveError.message.includes("checkout_links_hourly_limit")) {
      throw new CheckoutLinkError(
        "rate_limited",
        `At most ${CHECKOUT_LINKS_PER_HOUR} checkout links an hour for one account. Hand the person a link already made, or try again later.`,
        429
      );
    }
    if (reserveError.message.includes("checkout_links_open_limit")) {
      throw new CheckoutLinkError(
        "too_many_open",
        `${CHECKOUT_LINKS_OPEN} checkout links are still open for this account. Let the person finish one, or wait for one to expire.`,
        409
      );
    }
    throw reserveError;
  }

  const { data: row, error } = await admin
    .from("billing_checkouts")
    .select(COLUMNS)
    .eq("id", id as string)
    .single<Row>();
  if (error) throw error;
  return view(row);
}

async function readRow(id: string): Promise<Row | null> {
  const { data, error } = await createAdminClient()
    .from("billing_checkouts")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle<Row>();
  if (error) throw error;
  return data;
}

/** Whether the person owns the team now; other failures propagate. */
async function ownsTeam(teamId: string, userId: string): Promise<boolean> {
  try {
    await getTeamForOwner(userId, teamId);
    return true;
  } catch (error) {
    if (error instanceof TeamBillingError) return false;
    throw error;
  }
}

/**
 * Whether the person may follow the link: its asker for their own account;
 * for a team, its asker or the team's owner now, and only while the asker
 * still owns the team (a former owner's keys and agents lose the links they
 * made with the team).
 */
async function mayFollow(row: Row, userId: string): Promise<boolean> {
  if (!row.team_id) return row.created_by === userId && row.user_id === userId;
  if (!(await ownsTeam(row.team_id, row.created_by))) return false;
  return row.created_by === userId || (await ownsTeam(row.team_id, userId));
}

/**
 * A link for the person who may follow it (mayFollow(): any of their keys,
 * agents or sessions), or null. One still open past its expiry is settled
 * from Polar's state of its session, at most every 30 seconds: a checkout
 * paid before it expired is paid even when its webhook has not arrived yet.
 */
export async function getCheckoutLink(
  id: string,
  userId: string
): Promise<CheckoutLinkView | null> {
  const data = await readRow(id);
  if (!data || !(await mayFollow(data, userId))) return null;
  return view(await settleIfExpired(data));
}

/**
 * Expires a link nobody has opened yet, for whoever may follow it (its
 * asker, or the team's owner): it can no longer be opened, and nothing was
 * made in Polar. A link already opened has a Polar checkout that cannot be
 * ended, so it is refused (it expires on its own); one already expired is
 * answered as it is. Throws CheckoutLinkError not_found, opening, opened
 * and not_open.
 */
export async function expireCheckoutLink(id: string, userId: string): Promise<CheckoutLinkView> {
  const data = await readRow(id);
  if (!data || !(await mayFollow(data, userId))) {
    throw new CheckoutLinkError("not_found", "Checkout link not found", 404);
  }
  const row = await settleIfExpired(data);
  if (row.status === "expired") return view(row);
  if (row.status !== "open") {
    throw new CheckoutLinkError(
      "not_open",
      `This checkout link is ${row.status === "paid" ? "already paid" : "already settled"}, so there is nothing to cancel.`,
      409
    );
  }
  if (row.polar_checkout_id) {
    throw new CheckoutLinkError(
      "opened",
      `The person already opened this link, and Polar's checkout cannot be ended. It expires on its own at ${row.expires_at}.`,
      409
    );
  }
  // Fenced on nobody opening it meanwhile: a tab holding the open lease is
  // making Polar's checkout right now.
  const leaseCutoff = new Date(Date.now() - OPENING_LEASE_MS).toISOString();
  const { data: expired, error } = await createAdminClient()
    .from("billing_checkouts")
    .update({
      status: "expired",
      expires_at: new Date().toISOString(),
      // A tab opening it meanwhile may still make a team's session that
      // names it; that session's payment never marks it paid (settlePaid()).
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "open")
    .is("polar_checkout_id", null)
    .or(`opening_at.is.null,opening_at.lt."${leaseCutoff}"`)
    .select(COLUMNS);
  if (error) throw error;
  const changed = (expired as Row[] | null)?.[0];
  if (changed) return view(changed);
  throw new CheckoutLinkError(
    "opening",
    "The person is opening this link right now. Check it again in a moment.",
    409
  );
}

/**
 * Names a key, an agent or a team's owner wrote themselves, cleaned like
 * every name someone else chose (cleanUntrustedName: no control or
 * formatting characters, no quotes of any kind that could close the name
 * early, one line, at most `max` code points). Null when nothing is left.
 */
export function cleanAskerName(name: string | null | undefined, max = 60): string | null {
  if (typeof name !== "string") return null;
  return cleanUntrustedName(name, max) || null;
}

/**
 * Who asked for a link, as fields for the page to lay out: the kind, and
 * the name and key prefix the key or agent chose (cleaned, never built into
 * a sentence here, so the page can set them apart as the asker's own words).
 * `session` is a browser session, or a key or agent removed since (its
 * reference is cleared).
 */
export interface CheckoutRequester {
  kind: "agent" | "key" | "session";
  name: string | null;
  /** The key's prefix, for a key. */
  prefix: string | null;
}

async function requesterOf(row: Row): Promise<CheckoutRequester> {
  const admin = createAdminClient();
  if (row.requested_by_agent) {
    const { data, error } = await admin
      .from("agent_registrations")
      .select("client_name")
      .eq("id", row.requested_by_agent)
      .maybeSingle();
    if (error) throw error;
    return { kind: "agent", name: cleanAskerName(data?.client_name), prefix: null };
  }
  if (row.requested_by_key) {
    const { data, error } = await admin
      .from("api_keys")
      .select("name, key_prefix")
      .eq("id", row.requested_by_key)
      .maybeSingle();
    if (error) throw error;
    return {
      kind: "key",
      name: cleanAskerName(data?.name),
      prefix: cleanAskerName(data?.key_prefix, 16),
    };
  }
  return { kind: "session", name: null, prefix: null };
}

/**
 * What the link costs, as far as it is known before Polar's page (tax comes
 * on top there). `have` as for checkoutSummary().
 */
export function checkoutPrice(item: StoredCheckoutItem, have = 0): string | null {
  switch (item.kind) {
    case "plan": {
      const price = PLAN_PRICES[item.plan][item.interval];
      return price ?? null;
    }
    case "team_plan":
      return formatSeatPricing(item.seats, item.plan, item.interval);
    case "blocks": {
      const each = item.resource === "pages" ? ONE_TIME_PAGE_BLOCK_CENTS : ONE_TIME_BLOCK_CENTS;
      return `${formatCents(each * item.blocks)} once`;
    }
    case "monthly_blocks": {
      const each =
        item.resource === "domains"
          ? MONTHLY_DOMAIN_CENTS
          : item.resource === "pages"
            ? MONTHLY_PAGE_BLOCK_CENTS
            : MONTHLY_BLOCK_CENTS;
      const added = item.blocks - have;
      if (have > 0 && added > 0) {
        return `${formatCents(each * added)} today for the ${added} added, then ${formatCents(each * item.blocks)} a month in all`;
      }
      return `${formatCents(each * item.blocks)} a month in all; the ones added now are charged in full today`;
    }
    case "overage":
      return item.resource === "pages"
        ? `${formatCents(PAGE_OVERAGE_CENTS)} a parsed page past the plan, billed with the plan`
        : `${formatCents(OVERAGE_BLOCK_CENTS)} for each 25,000 requests past the plan, billed with the plan`;
  }
}

/** What the checkout page shows before the person continues to payment. */
export interface CheckoutLinkReview {
  id: string;
  /**
   * processing: past its expiry with a Polar session not settled yet (the
   * 30-second check, or Polar unreachable), which may still be being paid.
   */
  status: BillingCheckoutStatus | "processing";
  kind: BillingCheckoutKind;
  /** What blocks or overage are of; null for a plan. */
  resource: string | null;
  summary: string;
  price: string | null;
  /** The account that pays: the signed-in person's email. */
  email: string | null;
  /** The team that pays, for a team link. */
  teamName: string | null;
  /** Who asked: the kind, and the name and prefix the asker chose. */
  requester: CheckoutRequester;
  /**
   * Why the account cannot buy this now (the purchase check, read before
   * anything is made), for an open link; null when it can.
   */
  unavailable: string | null;
  country: string | null;
  /** Whether the link was made from this browser's network. */
  network: NetworkMatch;
  createdAt: string;
  expiresAt: string;
}

/**
 * The checkout page's first look at a link, for the billing account's owner
 * (assertOwner()): what it buys and costs, who asked, when and from where.
 * Makes nothing in Polar, and claims nothing: only openCheckoutLink() does,
 * when the person continues. Throws CheckoutLinkError not_found and
 * wrong_account.
 */
export async function reviewCheckoutLink(
  id: string,
  userId: string,
  viewerNetwork: string | null
): Promise<CheckoutLinkReview> {
  const data = await readRow(id);
  if (!data) {
    throw new CheckoutLinkError("not_found", "This checkout link does not exist.", 404);
  }
  await assertOwner(data, userId);
  const row = await settleIfExpired(data);
  const item = storedItem(row);
  const status = isPastExpiry(row) ? pastExpiryKind(row) : row.status;
  const admin = createAdminClient();
  const [{ data: user, error: userError }, team] = await Promise.all([
    admin.from("users").select("email").eq("id", userId).maybeSingle(),
    row.team_id
      ? admin.from("teams").select("name").eq("id", row.team_id).maybeSingle()
      : Promise.resolve(null),
  ]);
  if (userError) throw userError;
  if (team?.error) throw team.error;
  const check =
    status === "open" ? await purchaseCheck(item, userId) : { unavailable: null, have: 0 };
  return {
    id: row.id,
    status,
    kind: row.kind,
    resource: "resource" in item ? item.resource : null,
    summary: checkoutSummary(item, check.have),
    price: checkoutPrice(item, check.have),
    email: user?.email ?? null,
    teamName: cleanAskerName(team?.data?.name, 80),
    requester: await requesterOf(row),
    unavailable: check.unavailable,
    country: row.country,
    network: compareNetworks(row.network, viewerNetwork),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * The purchase check opening the link runs, for the page to show first:
 * why it refuses the item now (null when it passes), and the monthly blocks
 * a top-up adds to. Database reads only: nothing in Polar is asked or made
 * until the person continues.
 */
async function purchaseCheck(
  item: StoredCheckoutItem,
  userId: string
): Promise<{ unavailable: string | null; have: number }> {
  try {
    const purchase = await purchaseFor(item, userId);
    return { unavailable: null, have: purchase?.have ?? 0 };
  } catch (error) {
    if (
      error instanceof BillingActionError ||
      error instanceof TeamBillingError ||
      error instanceof CapacityError
    ) {
      return { unavailable: error.message, have: 0 };
    }
    throw error;
  }
}

function isPastExpiry(row: Row): boolean {
  return row.status === "open" && Date.parse(row.expires_at) <= Date.now();
}

/**
 * What a link still open past its expiry (settleIfExpired() left it so)
 * reads as: expired when no session was made, else processing, since its
 * Polar session was not settled yet (asked under 30 seconds ago, Polar
 * unreachable, or a payment Polar is confirming) and may have been paid.
 * Never "nothing was charged" before Polar has said so.
 */
function pastExpiryKind(row: Row): "expired" | "processing" {
  return row.polar_checkout_id ? "processing" : "expired";
}

/** Settles an open link past its expiry: from Polar when it has a session, else expired. */
async function settleIfExpired(row: Row): Promise<Row> {
  if (!isPastExpiry(row)) return row;
  if (!row.polar_checkout_id) return (await markExpired(row.id)) ?? row;

  // Asked of Polar at most every 30 seconds, failed asks included: a link
  // polled every second must not ask Polar every second.
  const checkedAt = row.polar_checked_at ? Date.parse(row.polar_checked_at) : NaN;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < POLAR_CHECK_INTERVAL_MS) return row;
  const admin = createAdminClient();
  const { error: stampError } = await admin
    .from("billing_checkouts")
    .update({ polar_checked_at: new Date().toISOString() })
    .eq("id", row.id);
  if (stampError) throw stampError;

  let checkout: Record<string, unknown> | null;
  try {
    checkout = asRecord(await createPolarClient().checkouts.get(row.polar_checkout_id));
  } catch (error) {
    // Asked again on a later read; a read is never failed for it.
    console.warn("[checkout-links] could not read a checkout from Polar", {
      id: row.id,
      error: loggablePolarError(error),
    });
    return row;
  }
  const polarStatus = checkout ? asNonEmptyString(checkout.status) : null;
  // Confirmed: the payment is being processed, and its webhook settles it.
  if (polarStatus === "confirmed" || polarStatus === "open") return row;
  if (polarStatus === "succeeded") {
    return (await markPaid({ id: row.id }, checkout ? boughtFrom(checkout) : null)) ?? row;
  }
  return (await markExpired(row.id)) ?? row;
}

/** What an order, subscription or checkout from Polar holds. */
function boughtFrom(data: Record<string, unknown>): CheckoutBought {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    product: asNonEmptyString(data.product_id) ?? asNonEmptyString(asRecord(data.product)?.id),
    seats: num(data.seats),
    units: num(data.units),
    amount: num(data.net_amount) ?? num(data.amount),
    currency: asNonEmptyString(data.currency),
  };
}

/**
 * Moves links to paid from open or expired (paid wins, since a payment
 * confirmed before expiry can arrive after it), never from superseded, with
 * what was bought. Idempotent: a redelivery finds nothing left to change.
 * Returns the first row changed.
 */
async function markPaid(
  where: { id: string } | { polarCheckoutId: string },
  bought: CheckoutBought | null
): Promise<Row | null> {
  let query = createAdminClient()
    .from("billing_checkouts")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      ...(bought ? { bought: bought as unknown as Json } : {}),
    });
  query =
    "id" in where ? query.eq("id", where.id) : query.eq("polar_checkout_id", where.polarCheckoutId);
  const { data, error } = await query.in("status", ["open", "expired"]).select(COLUMNS);
  if (error) throw error;
  return (data as Row[] | null)?.[0] ?? null;
}

async function markExpired(id: string): Promise<Row | null> {
  const { data, error } = await createAdminClient()
    .from("billing_checkouts")
    .update({ status: "expired" })
    .eq("id", id)
    .eq("status", "open")
    .select(COLUMNS);
  if (error) throw error;
  return (data as Row[] | null)?.[0] ?? null;
}

/** What opening a link answers: Polar's page to go on to, or where the link stands. */
export type OpenCheckoutResult =
  | { kind: "redirect"; url: string; summary: string }
  | { kind: "paid" | "superseded" | "expired" | "processing"; summary: string };

/** Whether Polar's session is still the one to pay: open, and selling what the link expects. */
function stillSells(checkout: Record<string, unknown> | null, expected: CheckoutExpected | null) {
  if (!checkout || !expected || checkout.status !== "open") return false;
  const expiresAt = asNonEmptyString(checkout.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return false;
  const product =
    asNonEmptyString(checkout.product_id) ?? asNonEmptyString(asRecord(checkout.product)?.id);
  if (product !== expected.product) return false;
  if (expected.seats !== undefined && checkout.seats !== expected.seats) return false;
  if (expected.units !== undefined && checkout.units !== expected.units) return false;
  return asNonEmptyString(checkout.url) !== null;
}

/** Whether two purchases sell the same: product, seats and units. */
function sameExpected(a: CheckoutExpected, b: CheckoutExpected | null): boolean {
  return b !== null && a.product === b.product && a.seats === b.seats && a.units === b.units;
}

/**
 * The person opened the link on /checkout/{id}: the billing account's owner,
 * signed in (the route checks the session and its second factor). Checks
 * the purchase again, makes the Polar session (or reuses the link's while
 * Polar has it open) and answers where to send the person. Throws
 * CheckoutLinkError not_found and wrong_account, and the purchase checks'
 * own errors.
 */
export async function openCheckoutLink(id: string, userId: string): Promise<OpenCheckoutResult> {
  const admin = createAdminClient();
  const data = await readRow(id);
  if (!data) {
    throw new CheckoutLinkError("not_found", "This checkout link does not exist.", 404);
  }
  await assertOwner(data, userId);

  let row = await settleIfExpired(data);
  const item = storedItem(row);
  const summary = checkoutSummary(item);
  if (row.status !== "open") return { kind: row.status, summary };
  if (isPastExpiry(row)) return { kind: pastExpiryKind(row), summary };

  let storedSession: Record<string, unknown> | null = null;
  if (row.polar_checkout_id) {
    storedSession = asRecord(await createPolarClient().checkouts.get(row.polar_checkout_id));
    const polarStatus = storedSession ? asNonEmptyString(storedSession.status) : null;
    if (polarStatus === "confirmed") return { kind: "processing", summary };
    if (polarStatus === "succeeded") {
      // Already paid (the webhook came first): read it again rather than
      // answer the stale open copy as processing.
      row =
        (await markPaid({ id: row.id }, storedSession ? boughtFrom(storedSession) : null)) ??
        (await readRow(row.id)) ??
        row;
      return { kind: row.status === "open" ? "processing" : row.status, summary };
    }
  }

  // The purchase is checked again before any session is handed out, a
  // stored one included: the account may have changed since it was made
  // (a plan bought meanwhile, blocks added in the dashboard).
  const purchase = await purchaseFor(item, userId);
  if (
    storedSession &&
    sameExpected(purchase.expected, asExpected(row.expected)) &&
    stillSells(storedSession, purchase.expected)
  ) {
    return { kind: "redirect", url: String(storedSession.url), summary };
  }
  // No session yet, expired at Polar, moved to another purchase, or no
  // longer what the account would buy now: a session is found or made for
  // what it buys now, below.

  // One tab makes the session; another opening it meanwhile waits for it.
  // The lease's own timestamp fences what this tab writes afterwards, so a
  // tab stalled past the lease never overwrites or releases another's.
  const leaseCutoff = new Date(Date.now() - OPENING_LEASE_MS).toISOString();
  const lease = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("billing_checkouts")
    .update({ opening_at: lease })
    .eq("id", row.id)
    .eq("status", "open")
    .or(`opening_at.is.null,opening_at.lt."${leaseCutoff}"`)
    .select("id, polar_checkout_id, previous_checkout_ids")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return settledSince(row.id, summary);
  // The session this one replaces, as the row holds it under the lease.
  const replaced = asNonEmptyString(claimed.polar_checkout_id);
  const previous = Array.isArray(claimed.previous_checkout_ids)
    ? claimed.previous_checkout_ids
    : [];

  try {
    const successUrl = `${await accountHomeOrigin(userId)}${CHECKOUT_COMPLETE_PATH}`;
    const session = await purchase.mint({ id: row.id, successUrl });
    if (!session.id) {
      // A team's open session cached before ids were stored: it cannot be followed.
      throw new CheckoutLinkError(
        "checkout_in_progress",
        "A checkout for this team is already open in the dashboard. Finish it there, or try again once it expires.",
        409
      );
    }
    const sessionExpiry = Date.parse(
      session.expiresAt ?? new Date(Date.now() + FALLBACK_EXPIRY_MS).toISOString()
    );
    const expiresAt = new Date(Math.max(Date.parse(row.expires_at), sessionExpiry)).toISOString();
    const { data: written, error: writeError } = await admin
      .from("billing_checkouts")
      .update({
        polar_checkout_id: session.id,
        // Polar cannot end the session replaced here, so it may still be
        // paid: kept so its payment finds the link (settlePaid()).
        ...(replaced && replaced !== session.id
          ? {
              previous_checkout_ids: [...previous.filter((id) => id !== replaced), replaced].slice(
                -MAX_PREVIOUS_CHECKOUTS
              ),
            }
          : {}),
        expected: purchase.expected as unknown as Json,
        // The session is the link's own now, made for it after any detach.
        detached_at: null,
        opening_at: null,
        expires_at: expiresAt,
      })
      .eq("id", row.id)
      .eq("status", "open")
      .eq("opening_at", lease)
      .select("id");
    if (writeError) throw writeError;
    if (!written || written.length === 0) {
      // The lease ran out and another tab took it (the link follows that
      // tab's session, and this one is never handed out), or the link
      // stopped being open meanwhile.
      return await settledSince(row.id, summary);
    }
    return { kind: "redirect", url: session.url, summary };
  } catch (failure) {
    // Best effort, and only this tab's own lease: the lease's 30 seconds
    // are the backstop.
    await admin
      .from("billing_checkouts")
      .update({ opening_at: null })
      .eq("id", row.id)
      .eq("opening_at", lease);
    throw failure;
  }
}

/**
 * The answer when the lease could not be taken or kept: the link as it is
 * now. One no longer open (paid, superseded, expired or cancelled, which
 * reads expired) says so; only one still open is being prepared in another
 * tab (CheckoutLinkError opening, 409).
 */
async function settledSince(id: string, summary: string): Promise<OpenCheckoutResult> {
  const now = await readRow(id);
  if (!now) {
    throw new CheckoutLinkError("not_found", "This checkout link does not exist.", 404);
  }
  if (now.status !== "open") return { kind: now.status, summary };
  if (isPastExpiry(now)) return { kind: pastExpiryKind(now), summary };
  throw new CheckoutLinkError(
    "opening",
    "This checkout is being prepared in another tab. Try again in a moment.",
    409
  );
}

/**
 * Only the billing account's owner opens a link: the user, or the team's
 * owner now (ownership may have moved since the link was made).
 */
async function assertOwner(row: Row, userId: string): Promise<void> {
  const refusal = new CheckoutLinkError(
    "wrong_account",
    "This checkout link is for another account. Sign in as the account it was made for to pay it.",
    403
  );
  if (row.team_id) {
    try {
      await assertCanManage({ kind: "team", teamId: row.team_id }, userId);
    } catch (error) {
      if (error instanceof TeamBillingError) throw refusal;
      throw error;
    }
    return;
  }
  if (row.user_id !== userId) throw refusal;
}

const ACTIVE_SUBSCRIPTION = new Set(["active", "trialing"]);
/** The replaced sessions a link keeps (migration 00104 caps the column at 20). */
const MAX_PREVIOUS_CHECKOUTS = 20;
const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Marks paid the links a paid Polar session belongs to: those that follow
 * it, a link that replaced it with a new session (previous_checkout_ids,
 * paid with mismatch "replaced", so it reads paid and not matching rather
 * than open until it expires), and the link its metadata names (in case the
 * link could not store the session's id), with what the order,
 * subscription or checkout holds. Links already paid by the session take
 * what each later event adds (mergeBought()): an order's amount, and a
 * subscription's seats, which a team plan's order leaves out.
 *
 * A link known only from a replaced session or the metadata is paid only
 * while the subscription the payment made is still live in Polar: the plan
 * and add-on handlers, which run first, may just have ended it as a
 * duplicate, and a link must never read paid for a purchase that was undone
 * (they supersede it too; this covers an end that could not). A link its
 * asker cancelled is never paid through either.
 */
async function settlePaid(
  checkoutId: string,
  data: Record<string, unknown>,
  source: "order" | "subscription" | "checkout"
): Promise<void> {
  const bought = boughtFrom(data);
  await markPaid({ polarCheckoutId: checkoutId }, bought);
  const admin = createAdminClient();
  const subscriptionId =
    source === "subscription" ? asNonEmptyString(data.id) : asNonEmptyString(data.subscription_id);
  let live: boolean | null = null;
  const stillLive = async () => {
    if (subscriptionId === null) return true;
    live ??= await isLiveSubscription(subscriptionId);
    return live;
  };
  const safeId = CHECKOUT_ID.test(checkoutId);

  if (safeId) {
    // A link that went on to a new session after this one; read first, so
    // only that case asks Polar anything.
    const { data: replacedBy, error: replacedError } = await admin
      .from("billing_checkouts")
      .select("id")
      .contains("previous_checkout_ids", [checkoutId])
      .in("status", ["open", "expired"])
      .is("cancelled_at", null);
    if (replacedError) throw replacedError;
    if ((replacedBy ?? []).length > 0 && (await stillLive())) {
      const { error } = await admin
        .from("billing_checkouts")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          bought: bought as unknown as Json,
          mismatch: "replaced",
        })
        .contains("previous_checkout_ids", [checkoutId])
        .in("status", ["open", "expired"])
        .is("cancelled_at", null);
      if (error) throw error;
    }
  }

  const named = checkoutLinkNamedBy(data.metadata);
  if (named && safeId) {
    // A link that follows the session was paid above; this is one that
    // never stored it.
    const { data: waiting, error: readError } = await admin
      .from("billing_checkouts")
      .select("id")
      .eq("id", named)
      .in("status", ["open", "expired"])
      // A link let go of a session that was moved to another purchase
      // (detachCheckoutLinks()) is not paid by that session, even when its
      // metadata still names the link: Polar's types do not say whether a
      // metadata update replaces or merges.
      .is("detached_at", null)
      .is("cancelled_at", null)
      .is("polar_checkout_id", null)
      .maybeSingle();
    if (readError) throw readError;
    if (waiting && (await stillLive())) {
      const { error } = await admin
        .from("billing_checkouts")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          polar_checkout_id: checkoutId,
          bought: bought as unknown as Json,
        })
        .eq("id", named)
        .in("status", ["open", "expired"])
        .is("detached_at", null)
        .is("cancelled_at", null)
        .is("polar_checkout_id", null);
      if (error) throw error;
    }
  }

  // Links the session paid before this event: what it adds.
  let paid = admin.from("billing_checkouts").select("id, bought").eq("status", "paid");
  paid = safeId
    ? paid.or(`polar_checkout_id.eq.${checkoutId},previous_checkout_ids.cs.{${checkoutId}}`)
    : paid.eq("polar_checkout_id", checkoutId);
  const { data: paidRows, error: paidError } = await paid;
  if (paidError) throw paidError;
  for (const paidRow of (paidRows ?? []) as Array<{ id: string; bought: Json | null }>) {
    const existing = asBought(paidRow.bought);
    const merged = mergeBought(existing, bought, source);
    if (existing && sameBought(existing, merged)) continue;
    const { error } = await admin
      .from("billing_checkouts")
      .update({ bought: merged as unknown as Json })
      .eq("id", paidRow.id)
      .eq("status", "paid");
    if (error) throw error;
  }
}

/**
 * What a paid link holds once another event for its session arrives. The
 * product, seats and units are the latest event's where it has them, else
 * kept (a team plan's order leaves out the seats its subscription has). The
 * amount and currency are the order's, the payment's own; a subscription
 * or checkout event only fills them in when none is known.
 */
export function mergeBought(
  existing: CheckoutBought | null,
  incoming: CheckoutBought,
  source: "order" | "subscription" | "checkout"
): CheckoutBought {
  if (!existing) return incoming;
  const payment = source === "order";
  return {
    product: incoming.product ?? existing.product,
    seats: incoming.seats ?? existing.seats,
    units: incoming.units ?? existing.units,
    amount: payment ? (incoming.amount ?? existing.amount) : (existing.amount ?? incoming.amount),
    currency: payment
      ? (incoming.currency ?? existing.currency)
      : (existing.currency ?? incoming.currency),
  };
}

function sameBought(a: CheckoutBought, b: CheckoutBought): boolean {
  return (
    a.product === b.product &&
    a.seats === b.seats &&
    a.units === b.units &&
    a.amount === b.amount &&
    a.currency === b.currency
  );
}

/**
 * The Polar webhook's part: a paid order or a live subscription that came
 * from a link's session marks the link paid, and a checkout Polar reports
 * succeeded or expired settles it too. A link already superseded (the
 * webhook undid its purchase as a duplicate, queueing a refund for review) stays so. Every other
 * event, and every session no link follows, changes nothing.
 */
export async function settleCheckoutLinkFromWebhook(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  if (eventType === "order.paid") {
    const checkoutId = asNonEmptyString(data.checkout_id);
    if (checkoutId) await settlePaid(checkoutId, data, "order");
    return;
  }
  if (
    eventType === "subscription.created" ||
    eventType === "subscription.active" ||
    eventType === "subscription.updated"
  ) {
    const checkoutId = asNonEmptyString(data.checkout_id);
    const status = asNonEmptyString(data.status);
    if (checkoutId && status && ACTIVE_SUBSCRIPTION.has(status) && !data.ended_at) {
      await settlePaid(checkoutId, data, "subscription");
    }
    return;
  }
  if (eventType === "checkout.updated" || eventType === "checkout.expired") {
    const checkoutId = asNonEmptyString(data.id);
    const status = asNonEmptyString(data.status);
    if (!checkoutId) return;
    if (status === "succeeded") await settlePaid(checkoutId, data, "checkout");
    else if (status === "expired") {
      // Only links still waiting on this session; a link whose session
      // expired can still be opened again before the link itself expires.
      const { error } = await createAdminClient()
        .from("billing_checkouts")
        .update({ status: "expired" })
        .eq("polar_checkout_id", checkoutId)
        .eq("status", "open")
        .lte("expires_at", new Date().toISOString());
      if (error) throw error;
    }
  }
}
