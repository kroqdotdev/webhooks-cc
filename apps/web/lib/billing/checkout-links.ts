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
import { checkoutLinkNamedBy, linkCustomerMatches } from "@/lib/billing/checkout-link-rows";
import { compareNetworks, type NetworkMatch } from "@/lib/device-requester";
import { cleanUntrustedName } from "@/lib/untrusted-name";
import { createPolarClient, loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
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
import { refundTargetKey } from "@/lib/billing/refunds";
import type {
  BillingCheckoutExpiredReason,
  BillingCheckoutKind,
  BillingCheckoutStatus,
  Database,
  Json,
} from "@/lib/supabase/database";
import {
  getTeamForOwner,
  TeamBillingError,
  teamCheckoutBlocked,
  teamPlanPurchase,
} from "@/lib/supabase/team-billing";

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
/**
 * How long past its expiry a link whose Polar session still reads open, or
 * cannot be read, is held as processing before it reads expired. A payment
 * that arrives later still marks it paid (markPaid() moves expired links).
 */
export const EXPIRY_GRACE_MS = 15 * 60_000;
/**
 * How long past its expiry a link whose session Polar is still confirming
 * (a payment being processed) is held as processing; then it reads expired,
 * and the payment, should it land, still marks it paid.
 */
export const CONFIRMING_GRACE_MS = 24 * 60 * 60_000;
/** A read past expiry gives up on one Polar session after this many seconds... */
const POLAR_READ_TIMEOUT_S = 5;
/** ...reads this many at once... */
const POLAR_READS_AT_ONCE = 4;
/** ...and on the rest after this long in all: those not read count as unsettled. */
const SETTLE_DEADLINE_MS = 15_000;
/** How long after a link is paid later events may still fill in what it bought. */
const BOUGHT_FILL_WINDOW_MS = 10 * 60_000;
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
 * set once it is paid: whether what was bought is what the link asked for
 * (null while that is not known yet, say the seats before the
 * subscription's event).
 */
export interface CheckoutLinkView {
  id: string;
  status: BillingCheckoutStatus;
  kind: BillingCheckoutKind;
  summary: string;
  item: StoredCheckoutItem;
  teamId: string | null;
  url: string | null;
  /**
   * Whether the person opened it (continued to payment, so a Polar session
   * may have been made for it), so a payment may still land after it
   * expires; one never opened was never payable.
   */
  opened: boolean;
  /**
   * Why an expired link expired, when it is not simply unpaid: "unsettled",
   * a payment Polar was still confirming a day past its expiry, or sessions
   * Polar could not be read about 15 minutes past it. Such a link may have
   * been paid: a payment that lands still turns it paid, and we have been
   * alerted. Null otherwise.
   */
  expiredReason: BillingCheckoutExpiredReason | null;
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
 * either side is unknown, a count the link names included: an order handled
 * before its subscription event leaves out a team plan's seats, which the
 * subscription fills in (mergeBought()), so until then it is not known yet
 * rather than different. A product or count that is known and differs is
 * false at once.
 */
export function boughtMatches(
  expected: CheckoutExpected | null,
  bought: CheckoutBought | null
): boolean | null {
  if (!expected || !bought || !bought.product) return null;
  if (bought.product !== expected.product) return false;
  let unknown = false;
  for (const [want, got] of [
    [expected.seats, bought.seats],
    [expected.units, bought.units],
  ] as const) {
    if (want === undefined) continue;
    if (got === null) unknown = true;
    else if (got !== want) return false;
  }
  return unknown ? null : true;
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
    // Stamped with the first opening lease, and kept when the session is
    // detached or replaced later: a session that names the link may exist.
    opened: row.opened_at !== null || paid,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    expiredReason: row.status === "expired" ? (row.expired_reason ?? null) : null,
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
  "id, user_id, team_id, created_by, requested_by_key, requested_by_agent, network, country, kind, item, url, polar_checkout_id, paid_checkout_id, previous_checkout_ids, expected, bought, mismatch, detached_at, cancelled_at, opening_at, opened_at, polar_checked_at, status, expired_reason, created_at, expires_at, paid_at";

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
 * from Polar's state of its session, at most every 30 seconds: a read marks
 * a paid checkout paid only when Polar shows the live subscription it made
 * (paidAtPolar()), so a subscription paid before the link expired reads
 * paid even when its webhook has not arrived yet; a one-time order turns
 * the link paid only through the webhook (the link reads processing until
 * then).
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
  /**
   * The refusal's code: checkout_in_progress is for now only (another
   * checkout link's checkout for the team is open until the time the
   * message names), so the page offers Try again instead of the Plan page.
   */
  unavailableCode: string | null;
  /** As CheckoutLinkView's: why an expired link expired, when it may have been paid. */
  expiredReason: BillingCheckoutExpiredReason | null;
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
  const check: PurchaseCheck =
    status === "open"
      ? await purchaseCheck(item, userId)
      : { unavailable: null, unavailableCode: null, have: 0 };
  // Overage opens with the maximum the account has stored now.
  const shown = withOpenMax(item, check.max);
  return {
    id: row.id,
    status,
    kind: row.kind,
    resource: "resource" in item ? item.resource : null,
    summary: checkoutSummary(shown, check.have),
    price: checkoutPrice(shown, check.have),
    email: user?.email ?? null,
    teamName: cleanAskerName(team?.data?.name, 80),
    requester: await requesterOf(row),
    unavailable: check.unavailable,
    unavailableCode: check.unavailableCode,
    expiredReason: status === "expired" ? (row.expired_reason ?? null) : null,
    country: row.country,
    network: compareNetworks(row.network, viewerNetwork),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

interface PurchaseCheck {
  unavailable: string | null;
  unavailableCode: string | null;
  have: number;
  max?: number;
}

/**
 * The purchase check opening the link runs, for the page to show first:
 * why it refuses the item now (null when it passes), and the monthly blocks
 * a top-up adds to. A team link also answers why opening would be refused
 * while another checkout link's checkout for the team is open
 * (teamCheckoutBlocked(): checkout_in_progress, until that one expires).
 * Database reads only: nothing in Polar is asked or made until the person
 * continues.
 */
async function purchaseCheck(item: StoredCheckoutItem, userId: string): Promise<PurchaseCheck> {
  try {
    const purchase = await purchaseFor(item, userId);
    if (item.kind === "team_plan") {
      const blocked = await teamCheckoutBlocked(item.teamId, purchase.expected);
      if (blocked) {
        return { unavailable: blocked.message, unavailableCode: blocked.code, have: 0 };
      }
    }
    return {
      unavailable: null,
      unavailableCode: null,
      have: purchase?.have ?? 0,
      max: purchase?.max,
    };
  } catch (error) {
    if (
      error instanceof BillingActionError ||
      error instanceof TeamBillingError ||
      error instanceof CapacityError
    ) {
      return { unavailable: error.message, unavailableCode: error.code, have: 0 };
    }
    throw error;
  }
}

/**
 * An overage item with the maximum its session is opened with: the one the
 * account has stored when the link is opened (overagePurchase()), so a
 * maximum changed after the link was made is the one the link names and
 * its subscription is given.
 */
function withOpenMax(item: StoredCheckoutItem, max: number | undefined): StoredCheckoutItem {
  return item.kind === "overage" && max !== undefined ? { ...item, max } : item;
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

/**
 * Settles an open link past its expiry: from Polar when it has a session,
 * else expired. Every session the link followed is asked, the ones it
 * replaced too (previous_checkout_ids), since Polar cannot end a session:
 * one paid marks the link paid (a replaced one through settlePaid(), which
 * checks its purchase still stands); one Polar is still confirming keeps it
 * processing for CONFIRMING_GRACE_MS past its expiry; one still open, or
 * one not read (Polar not answering, or past the reads' deadline), keeps it
 * processing for EXPIRY_GRACE_MS past its expiry. Then it reads expired (a
 * payment that arrives later still marks it paid), with expired_reason
 * 'unsettled' when it was let go of for either of those (it may have been
 * paid: the page and the waits never say nothing was charged, and someone
 * is alerted). A read is never failed for Polar: what could not be settled
 * is asked again later. Every call to Polar, the subscription reads
 * included, gives up after POLAR_READ_TIMEOUT_S, and none starts once
 * SETTLE_DEADLINE_MS has passed (what is left counts as unsettled).
 */
async function settleIfExpired(row: Row): Promise<Row> {
  if (!isPastExpiry(row)) return row;
  if (!row.polar_checkout_id) return (await markExpired(row.id)) ?? row;

  // Asked of Polar at most every 30 seconds, failed asks included, and by
  // one read at a time: a link polled every second, or by several clients,
  // must not ask Polar every time. The stamp is the claim.
  const checkedAt = row.polar_checked_at ? Date.parse(row.polar_checked_at) : NaN;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < POLAR_CHECK_INTERVAL_MS) return row;
  const admin = createAdminClient();
  const checkCutoff = new Date(Date.now() - POLAR_CHECK_INTERVAL_MS).toISOString();
  const { data: claimed, error: stampError } = await admin
    .from("billing_checkouts")
    .update({ polar_checked_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "open")
    .or(`polar_checked_at.is.null,polar_checked_at.lt."${checkCutoff}"`)
    .select("id");
  if (stampError) throw stampError;
  if (!claimed || claimed.length === 0) return row;

  const current = row.polar_checkout_id;
  // The link's own session first, then the ones it replaced, newest first.
  const sessions = [
    current,
    ...[...(row.previous_checkout_ids ?? [])].reverse().filter((id) => id !== current),
  ];
  const stopAt = Date.now() + SETTLE_DEADLINE_MS;
  const answers = await readSessions(row.id, sessions, stopAt);
  // A payment Polar is confirming, or one it took that the webhook has not
  // settled yet.
  let confirming = false;
  let unsettled = false;
  for (const [i, sessionId] of sessions.entries()) {
    const answer = answers[i];
    if (answer === undefined) {
      unsettled = true;
      continue;
    }
    const checkout = answer;
    const polarStatus = checkout ? asNonEmptyString(checkout.status) : null;
    if (polarStatus === "succeeded" && checkout) {
      // Only a subscription Polar has live is marked paid here; the rest
      // waits for the webhook, which checks for duplicates first.
      const paid = await paidAtPolar(row.id, checkout, stopAt);
      if (paid === "unread") {
        unsettled = true;
        continue;
      }
      if (paid === "not_live") {
        confirming = true;
        continue;
      }
      if (sessionId === current) {
        return (
          (await markPaid({ id: row.id }, boughtFrom(checkout), current)) ??
          (await readRow(row.id)) ??
          row
        );
      }
      // settlePaid() asks Polar about the subscription again: never once
      // the reads' deadline has passed.
      if (Date.now() >= stopAt) {
        unsettled = true;
        continue;
      }
      try {
        await settlePaid(
          sessionId,
          checkout,
          { source: "checkout" },
          { timeout: POLAR_READ_TIMEOUT_S }
        );
      } catch (error) {
        // The webhook, or a later read, applies it.
        console.warn("[checkout-links] could not apply a replaced session's payment", {
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        unsettled = true;
        continue;
      }
      const now = await readRow(row.id);
      if (now && now.status !== "open") return now;
      continue;
    }
    // Confirmed: the payment is being processed, and its webhook settles it.
    if (polarStatus === "confirmed") confirming = true;
    else if (polarStatus === "open") unsettled = true;
  }
  const expiry = Date.parse(row.expires_at);
  if (confirming && Date.now() < expiry + CONFIRMING_GRACE_MS) return row;
  if (unsettled && Date.now() < expiry + EXPIRY_GRACE_MS) return row;
  // Let go of while Polar never said it was not paid: it may have been.
  const letGo = confirming || unsettled;
  const expired = await markExpired(row.id, letGo ? "unsettled" : null);
  if (expired && letGo) {
    // A payment Polar took or was confirming without its webhook settling
    // it for a day, or sessions Polar could not be read about: someone
    // should look. Its payment, should it land, still marks it paid.
    reportError(
      confirming
        ? "[checkout-links] a checkout link's payment stayed unsettled for a day; expired it"
        : "[checkout-links] a checkout link's Polar sessions could not be read past its grace; expired it",
      undefined,
      { linkId: row.id }
    );
  }
  return expired ?? row;
}

/**
 * Whether a read may mark a link paid from Polar's succeeded session: only
 * when the session made a subscription Polar has live ("live"). The
 * webhook's duplicate checks may still end it, and the link then turns
 * superseded; a one-time order, a subscription not live, or Polar not
 * answering is left to the webhook ("not_live": the link reads processing
 * meanwhile). With `stopAt` (a read past expiry), the subscription is not
 * asked about once that time has passed, and the read gives up after
 * POLAR_READ_TIMEOUT_S: "unread", which the caller counts as unsettled.
 */
async function paidAtPolar(
  linkId: string,
  checkout: Record<string, unknown>,
  stopAt?: number
): Promise<"live" | "not_live" | "unread"> {
  const subscription = asNonEmptyString(checkout.subscription_id);
  if (!subscription) return "not_live";
  if (stopAt !== undefined && Date.now() >= stopAt) return "unread";
  try {
    const live = await isLiveSubscription(
      subscription,
      stopAt === undefined ? undefined : { timeout: POLAR_READ_TIMEOUT_S }
    );
    return live ? "live" : "not_live";
  } catch (error) {
    console.warn("[checkout-links] could not read a checkout's subscription from Polar", {
      id: linkId,
      error: loggablePolarError(error),
    });
    // Past expiry a failed read is unsettled, as documented; before it the
    // link reads processing and the webhook decides.
    return stopAt === undefined ? "not_live" : "unread";
  }
}

/**
 * Polar's state of each session, in the order given: a few at once, each
 * read giving up after POLAR_READ_TIMEOUT_S, and all of them after
 * SETTLE_DEADLINE_MS. Undefined for a session not read (a failure, a
 * timeout, or not reached in time); null for an answer that is no record.
 */
async function readSessions(
  linkId: string,
  sessions: string[],
  stopAt: number
): Promise<Array<Record<string, unknown> | null | undefined>> {
  const polar = createPolarClient();
  const answers: Array<Record<string, unknown> | null | undefined> = sessions.map(() => undefined);
  let next = 0;
  const reader = async () => {
    while (next < sessions.length && Date.now() < stopAt) {
      const i = next++;
      try {
        const answer = asRecord(
          await polar.checkouts.get(sessions[i], { timeout: POLAR_READ_TIMEOUT_S })
        );
        if (Date.now() < stopAt) answers[i] = answer;
      } catch (error) {
        // Asked again on a later read; a read is never failed for it.
        console.warn("[checkout-links] could not read a checkout from Polar", {
          id: linkId,
          error: loggablePolarError(error),
        });
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, stopAt - Date.now()));
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(POLAR_READS_AT_ONCE, sessions.length) }, reader)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  // A copy: a read that finishes after the deadline changes nothing.
  return [...answers];
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
 * Moves links that follow a session to paid from open or expired (paid
 * wins, since a payment confirmed before expiry can arrive after it), with
 * what was bought and the session that paid (paid_checkout_id). With
 * `undone` (the webhook, by `polarCheckoutId`, once settlePaid() found the
 * purchase still live), superseded links too, but only those another of
 * their sessions superseded (paid_checkout_id names that one): that
 * purchase was undone, and this one stands; a link this session itself
 * superseded stays so. By id, only while the link still follows `session`.
 * Idempotent: a redelivery finds nothing left to change. Returns the first
 * row changed.
 */
async function markPaid(
  where: { id: string } | { polarCheckoutId: string },
  bought: CheckoutBought | null,
  session?: string,
  undone = false
): Promise<Row | null> {
  const paidBy = "id" in where ? session : where.polarCheckoutId;
  let query = createAdminClient()
    .from("billing_checkouts")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      ...(paidBy ? { paid_checkout_id: paidBy } : {}),
      ...(bought ? { bought: bought as unknown as Json } : {}),
    });
  if ("id" in where) {
    query = query.eq("id", where.id).in("status", ["open", "expired"]);
    if (session) query = query.eq("polar_checkout_id", session);
  } else {
    query = query.eq("polar_checkout_id", where.polarCheckoutId);
    query = undone
      ? query.or(payableThrough(where.polarCheckoutId)).is("cancelled_at", null)
      : query.in("status", ["open", "expired"]);
  }
  const { data, error } = await query.select(COLUMNS);
  if (error) throw error;
  return (data as Row[] | null)?.[0] ?? null;
}

async function markExpired(
  id: string,
  reason: BillingCheckoutExpiredReason | null = null
): Promise<Row | null> {
  const { data, error } = await createAdminClient()
    .from("billing_checkouts")
    .update({ status: "expired", ...(reason ? { expired_reason: reason } : {}) })
    .eq("id", id)
    .eq("status", "open")
    .select(COLUMNS);
  if (error) throw error;
  return (data as Row[] | null)?.[0] ?? null;
}

/**
 * What opening a link answers: Polar's page to go on to, or where the link
 * stands, with what it buys (`link`: its kind and resource, which the page
 * words a superseded link's explanation by).
 */
export type OpenCheckoutResult = (
  | { kind: "redirect"; url: string }
  | { kind: "paid" | "superseded" | "processing" }
  | {
      kind: "expired";
      /** As CheckoutLinkView's: "unsettled" when it may have been paid. */
      expiredReason: BillingCheckoutExpiredReason | null;
    }
) & { summary: string; link: OpenedLink };

/** The answer for a link that is no longer open, or past its expiry. */
function settledResult(row: Row, summary: string, link: OpenedLink): OpenCheckoutResult {
  const kind = row.status === "open" ? pastExpiryKind(row) : row.status;
  if (kind === "expired") {
    return {
      kind,
      expiredReason: row.status === "expired" ? (row.expired_reason ?? null) : null,
      summary,
      link,
    };
  }
  return { kind, summary, link };
}

/** What an opened link buys, for the page's wording. */
export interface OpenedLink {
  kind: BillingCheckoutKind;
  /** What blocks or overage are of; null for a plan. */
  resource: string | null;
}

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
  return openLink(id, userId, false);
}

async function openLink(id: string, userId: string, again: boolean): Promise<OpenCheckoutResult> {
  const admin = createAdminClient();
  const data = await readRow(id);
  if (!data) {
    throw new CheckoutLinkError("not_found", "This checkout link does not exist.", 404);
  }
  await assertOwner(data, userId);

  let row = await settleIfExpired(data);
  const item = storedItem(row);
  const summary = checkoutSummary(item);
  const link: OpenedLink = { kind: row.kind, resource: "resource" in item ? item.resource : null };
  if (row.status !== "open" || isPastExpiry(row)) return settledResult(row, summary, link);

  let storedSession: Record<string, unknown> | null = null;
  if (row.polar_checkout_id) {
    storedSession = asRecord(await createPolarClient().checkouts.get(row.polar_checkout_id));
    const polarStatus = storedSession ? asNonEmptyString(storedSession.status) : null;
    if (polarStatus === "confirmed") return { kind: "processing", summary, link };
    if (polarStatus === "succeeded") {
      // Paid at Polar: marked paid here only for a subscription Polar has
      // live, else the webhook settles it (processing meanwhile).
      if (!storedSession || (await paidAtPolar(row.id, storedSession)) !== "live") {
        return { kind: "processing", summary, link };
      }
      row =
        (await markPaid(
          { id: row.id },
          storedSession ? boughtFrom(storedSession) : null,
          row.polar_checkout_id
        )) ??
        (await readRow(row.id)) ??
        row;
      return row.status === "open"
        ? { kind: "processing", summary, link }
        : settledResult(row, summary, link);
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
    return { kind: "redirect", url: String(storedSession.url), summary, link };
  }
  // No session yet, expired at Polar, moved to another purchase, or no
  // longer what the account would buy now: a session is found or made for
  // what it buys now, below.

  // One tab makes the session; another opening it meanwhile waits for it.
  // The lease's own timestamp fences what this tab writes afterwards, so a
  // tab stalled past the lease never overwrites or releases another's.
  const leaseCutoff = new Date(Date.now() - OPENING_LEASE_MS).toISOString();
  const lease = new Date().toISOString();
  // Fenced on the session read above too: a tab that finished making one
  // meanwhile (and gave the lease back) is not replaced from a stale read.
  const observed = row.polar_checkout_id;
  // The first lease also stamps opened_at, for good: from here a Polar
  // session may be made for the link (a team's naming it in its metadata
  // too), even if this tab fails or the session is detached later.
  let claim = admin
    .from("billing_checkouts")
    .update({ opening_at: lease, ...(row.opened_at ? {} : { opened_at: lease }) })
    .eq("id", row.id)
    .eq("status", "open")
    .or(`opening_at.is.null,opening_at.lt."${leaseCutoff}"`);
  claim = observed ? claim.eq("polar_checkout_id", observed) : claim.is("polar_checkout_id", null);
  const { data: claimed, error: claimError } = await claim
    .select("id, polar_checkout_id, previous_checkout_ids")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) {
    // Another tab made a session since the read: start over once, which
    // hands out that session while it still sells the purchase.
    const now = await readRow(row.id);
    if (
      !again &&
      now &&
      now.status === "open" &&
      !isPastExpiry(now) &&
      now.polar_checkout_id !== observed &&
      !leaseHeld(now)
    ) {
      return openLink(id, userId, true);
    }
    return settledSince(row.id, summary, link, now);
  }
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
        // The maximum the overage session was made with, for the summary
        // and the subscription when it arrives.
        ...(item.kind === "overage" && purchase.max !== undefined && purchase.max !== item.max
          ? { item: withOpenMax(item, purchase.max) as unknown as Json }
          : {}),
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
      return await settledSince(row.id, summary, link);
    }
    return { kind: "redirect", url: session.url, summary, link };
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

/** Whether a tab holds the link's opening lease now. */
function leaseHeld(row: Row): boolean {
  return row.opening_at !== null && Date.now() - Date.parse(row.opening_at) < OPENING_LEASE_MS;
}

/**
 * The answer when the lease could not be taken or kept: the link as it is
 * now. One no longer open (paid, superseded, expired or cancelled, which
 * reads expired) says so; only one still open is being prepared in another
 * tab (CheckoutLinkError opening, 409).
 */
async function settledSince(
  id: string,
  summary: string,
  link: OpenedLink,
  read?: Row | null
): Promise<OpenCheckoutResult> {
  const now = read === undefined ? await readRow(id) : read;
  if (!now) {
    throw new CheckoutLinkError("not_found", "This checkout link does not exist.", 404);
  }
  if (now.status !== "open" || isPastExpiry(now)) return settledResult(now, summary, link);
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
 * subscription or checkout holds. A link paid through a session it had
 * replaced follows that session from then on (polar_checkout_id, the newer
 * one moving into previous_checkout_ids), so a later payment of the newer
 * session is a duplicate of a purchase that stands, never a change to it.
 * Every link records the session that paid it (paid_checkout_id); links
 * already paid by this session take what each later event fills in
 * (mergeBought()): an order's amount, and a subscription's seats, which a
 * team plan's order leaves out.
 *
 * A link known only from a replaced session or the metadata is paid only
 * while the subscription the payment made is still live in Polar: the plan
 * and add-on handlers, which run first, may just have ended it as a
 * duplicate, and a link must never read paid for a purchase that was undone
 * (they supersede it too; this covers an end that could not). A link its
 * asker cancelled is never paid through either, and one named only by the
 * metadata only when the payment came from its own account's Polar
 * customer (linkCustomerMatches()). The same holds for a link that follows
 * this session but was superseded by another of its sessions (that
 * purchase was undone, this one stands), and a one-time order that a
 * refund was recorded for (polar_refunds: it bought nothing) never pays a
 * link through a replaced session or the metadata. A succeeded session of
 * a one-time order (`source` "checkout", no subscription) names no order,
 * so it never pays a link those ways either: its order.paid does.
 *
 * `polar` bounds the subscription read (a read past expiry gives each call
 * to Polar POLAR_READ_TIMEOUT_S).
 */
async function settlePaid(
  checkoutId: string,
  data: Record<string, unknown>,
  event: BoughtEvent,
  polar?: { timeout?: number }
): Promise<void> {
  const { source } = event;
  const bought = boughtFrom(data);
  await markPaid({ polarCheckoutId: checkoutId }, bought);
  const admin = createAdminClient();
  const subscriptionId =
    source === "subscription" ? asNonEmptyString(data.id) : asNonEmptyString(data.subscription_id);
  const orderId = source === "order" ? asNonEmptyString(data.id) : null;
  let live: boolean | null = null;
  const stillLive = async () => {
    if (live !== null) return live;
    if (subscriptionId !== null) live = await isLiveSubscription(subscriptionId, polar);
    // A succeeded session of a one-time order names no order, so whether a
    // refund was recorded for it cannot be told here: its order.paid
    // decides (the links that follow the session were paid above).
    else if (source === "checkout") live = false;
    // A one-time order stands unless the webhook recorded a refund for it
    // (extra domains with nothing left to go on, an account deleted
    // meanwhile): such an order bought nothing.
    else live = orderId === null || !(await orderRefundRecorded(orderId));
    return live;
  };
  const safeId = CHECKOUT_ID.test(checkoutId);

  if (safeId) {
    // Links this payment may still pay that markPaid() above did not, read
    // first so only they ask Polar anything: one that went on to a new
    // session after this one (previous_checkout_ids), open, expired or
    // superseded by another of its sessions; and one that follows this
    // session but was superseded by another of its sessions. That other
    // purchase was undone, and this one stands.
    const { data: candidates, error: replacedError } = await admin
      .from("billing_checkouts")
      .select("id, polar_checkout_id, previous_checkout_ids")
      .or(
        `and(previous_checkout_ids.cs.{${checkoutId}},or(${payableThrough(checkoutId)})),` +
          `and(polar_checkout_id.eq."${checkoutId}",status.eq.superseded,paid_checkout_id.neq."${checkoutId}")`
      )
      .is("cancelled_at", null);
    if (replacedError) throw replacedError;
    const replacedBy = (candidates ?? []).filter((link) =>
      (link.previous_checkout_ids ?? []).includes(checkoutId)
    );
    const undone = (candidates ?? []).filter(
      (link) =>
        link.polar_checkout_id === checkoutId &&
        !(link.previous_checkout_ids ?? []).includes(checkoutId)
    );
    if ((candidates ?? []).length > 0 && (await stillLive())) {
      if (undone.length > 0)
        await markPaid({ polarCheckoutId: checkoutId }, bought, undefined, true);
      for (const link of replacedBy) await payThroughReplaced(link, checkoutId, bought);
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
    if (
      waiting &&
      (await linkCustomerMatches(named, asNonEmptyString(data.customer_id))) &&
      (await stillLive())
    ) {
      const { error } = await admin
        .from("billing_checkouts")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          polar_checkout_id: checkoutId,
          paid_checkout_id: checkoutId,
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

  // Links this session paid before this event: what it adds. Only those it
  // paid: a link paid through another of its sessions keeps that purchase.
  const { data: paidRows, error: paidError } = await admin
    .from("billing_checkouts")
    .select("id, bought, paid_at")
    .eq("status", "paid")
    .eq("paid_checkout_id", checkoutId);
  if (paidError) throw paidError;
  const billingReason = source === "order" ? asNonEmptyString(data.billing_reason) : null;
  for (const paidRow of (paidRows ?? []) as Array<{
    id: string;
    bought: Json | null;
    paid_at: string | null;
  }>) {
    const existing = asBought(paidRow.bought);
    const merged = mergeBought(existing, bought, {
      ...event,
      billingReason,
      paidAt: paidRow.paid_at,
    });
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
 * The statuses a link can be paid in through a session it had replaced:
 * open or expired, or superseded by another of its sessions (whose purchase
 * was undone; superseding records that session in paid_checkout_id).
 */
function payableThrough(checkoutId: string): string {
  return `status.in.(open,expired),and(status.eq.superseded,paid_checkout_id.neq."${checkoutId}")`;
}

/** Whether the webhook recorded a refund for a Polar order (polar_refunds): it bought nothing. */
async function orderRefundRecorded(orderId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("polar_refunds")
    .select("id")
    .eq("target", refundTargetKey({ order: orderId }))
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Marks a link paid through a session it had replaced: it follows that
 * session from then on, and the one it had moved to goes into
 * previous_checkout_ids, so a later payment of that one never reads as
 * this link's purchase. Fenced on the session the link followed when it was
 * read; when a reopen moved it meanwhile and the link still waits, the
 * event fails, so Polar delivers it again.
 */
async function payThroughReplaced(
  link: { id: string; polar_checkout_id: string | null; previous_checkout_ids: string[] | null },
  checkoutId: string,
  bought: CheckoutBought
): Promise<void> {
  const current = link.polar_checkout_id;
  const kept = (link.previous_checkout_ids ?? []).filter(
    (id) => id !== checkoutId && id !== current
  );
  const previous = (current && current !== checkoutId ? [...kept, current] : kept).slice(
    -MAX_PREVIOUS_CHECKOUTS
  );
  const admin = createAdminClient();
  let query = admin
    .from("billing_checkouts")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      bought: bought as unknown as Json,
      mismatch: "replaced",
      polar_checkout_id: checkoutId,
      paid_checkout_id: checkoutId,
      previous_checkout_ids: previous,
    })
    .eq("id", link.id)
    .or(payableThrough(checkoutId))
    .is("cancelled_at", null);
  query = current ? query.eq("polar_checkout_id", current) : query.is("polar_checkout_id", null);
  const { data: written, error } = await query.select("id");
  if (error) throw error;
  if (written && written.length > 0) return;
  const { data: now, error: readError } = await admin
    .from("billing_checkouts")
    .select("id")
    .eq("id", link.id)
    .contains("previous_checkout_ids", [checkoutId])
    .or(payableThrough(checkoutId))
    .is("cancelled_at", null)
    .maybeSingle();
  if (readError) throw readError;
  if (now)
    throw new Error("A checkout link moved to another session while its payment was applied");
}

/** The event a session's purchase details arrive with. */
export interface BoughtEvent {
  source: "order" | "subscription" | "checkout";
  /** The webhook's event type; none for a read past expiry. */
  type?: string;
  /** An order's billing_reason. */
  billingReason?: string | null;
  /** When the link was paid. */
  paidAt?: string | null;
}

/** Orders that are the purchase itself, not a renewal or a later change. */
const PURCHASE_REASONS = new Set(["purchase", "subscription_create"]);

/**
 * What a paid link holds once another event for its session arrives. The
 * first event that paid it decides the product, seats and units; a later
 * one only fills in what is still unknown (a team plan's order leaves out
 * the seats its subscription has), and only when it describes the purchase:
 * the subscription's created or active event, or any event within
 * BOUGHT_FILL_WINDOW_MS of the payment. Polar keeps the checkout on the
 * subscription for good, and its later updates (seats added a week later, a
 * move to another plan) are changes to the purchase, not what the link
 * bought. The amount and currency are the purchase's order (billing_reason
 * purchase or subscription_create); a later order (a renewal, a seat
 * change) only fills them in when none is known, and a subscription or
 * checkout event only within the same bounds as the counts.
 */
export function mergeBought(
  existing: CheckoutBought | null,
  incoming: CheckoutBought,
  event: BoughtEvent,
  now = Date.now()
): CheckoutBought {
  if (!existing) return incoming;
  const paidAt = event.paidAt ? Date.parse(event.paidAt) : NaN;
  const fills =
    event.type === "subscription.created" ||
    event.type === "subscription.active" ||
    (Number.isFinite(paidAt) && now - paidAt <= BOUGHT_FILL_WINDOW_MS);
  const fill = <T>(have: T | null, offered: T | null) => have ?? (fills ? offered : null);
  let amount = existing.amount;
  let currency = existing.currency;
  if (event.source === "order") {
    if (
      incoming.amount !== null &&
      (existing.amount === null || PURCHASE_REASONS.has(event.billingReason ?? ""))
    ) {
      amount = incoming.amount;
      currency = incoming.currency ?? existing.currency;
    }
  } else if (existing.amount === null && fills) {
    amount = incoming.amount;
    currency = existing.currency ?? incoming.currency;
  }
  return {
    product: fill(existing.product, incoming.product),
    seats: fill(existing.seats, incoming.seats),
    units: fill(existing.units, incoming.units),
    amount,
    currency,
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
    if (checkoutId) await settlePaid(checkoutId, data, { source: "order", type: eventType });
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
      await settlePaid(checkoutId, data, { source: "subscription", type: eventType });
    }
    return;
  }
  if (eventType === "checkout.updated" || eventType === "checkout.expired") {
    const checkoutId = asNonEmptyString(data.id);
    const status = asNonEmptyString(data.status);
    if (!checkoutId) return;
    if (status === "succeeded") {
      await settlePaid(checkoutId, data, { source: "checkout", type: eventType });
    } else if (status === "expired") {
      // Only links still waiting on this session; a link whose session
      // expired can still be opened again before the link itself expires.
      // One that replaced other sessions is left to a read past expiry
      // (settleIfExpired()), which asks Polar about those too.
      const { error } = await createAdminClient()
        .from("billing_checkouts")
        .update({ status: "expired" })
        .eq("polar_checkout_id", checkoutId)
        .eq("status", "open")
        .filter("previous_checkout_ids", "eq", "{}")
        .lte("expires_at", new Date().toISOString());
      if (error) throw error;
    }
  }
}
