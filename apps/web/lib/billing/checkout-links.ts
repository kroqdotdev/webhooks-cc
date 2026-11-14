/**
 * Checkout links (migration 00104): an API key, a claimed agent or a
 * session asks for a Polar checkout for something the account can buy and
 * hands its link to the person, who pays on Polar's page with their own
 * card. Nothing is charged until they do, so no approval is asked for; the
 * customer portal, plan changes and cancelling stay with a session.
 *
 * What a link can buy mirrors what the dashboard's checkout routes start
 * (a plan, a team subscription, one-time and monthly blocks, overage), and
 * goes through the same functions: their product, customer and eligibility
 * rules apply unchanged, only the success URL differs (the public page at
 * CHECKOUT_COMPLETE_PATH, which says nothing about the account).
 *
 * Rails: a pre-claim agent token (no user) is refused by the route's auth;
 * a team purchase needs the team's owner (getTeamForOwner() and
 * assertCanManage() refuse members); reserve_billing_checkout() holds each
 * billing account to 5 links an hour and 3 open at once.
 */
import { z } from "zod";
import { MAX_BLOCKS, MAX_EXTRA_DOMAINS, MAX_PAGE_BLOCKS } from "@/lib/capacity";
import { createPolarClient, loggablePolarError, polarAppUrl } from "@/lib/polar";
import { MIN_TEAM_SEATS, MAX_TEAM_SEATS } from "@/lib/team-pricing";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPlanCheckoutSession } from "@/lib/supabase/billing";
import { asNonEmptyString, type CheckoutSession } from "@/lib/supabase/billing-shared";
import {
  assertCanManage,
  createMonthlyBlocksCheckoutSession,
  createOneTimeBlocksCheckoutSession,
  createOverageCheckoutSession,
  type CapacityAccount,
} from "@/lib/supabase/capacity-billing";
import type {
  BillingCheckoutKind,
  BillingCheckoutStatus,
  Database,
  Json,
} from "@/lib/supabase/database";
import { createTeamCheckoutSession } from "@/lib/supabase/team-billing";

/** The public page Polar sends the person to after paying. */
export const CHECKOUT_COMPLETE_PATH = "/checkout/complete";
/** At most this many links per billing account in an hour (the migration holds it). */
export const CHECKOUT_LINKS_PER_HOUR = 5;
/** At most this many links open at once per billing account (the migration holds it). */
export const CHECKOUT_LINKS_OPEN = 3;
/** Polar's checkouts expire after an hour; used when one comes back without its expiry. */
const FALLBACK_EXPIRY_MS = 60 * 60_000;

type Row = Database["public"]["Tables"]["billing_checkouts"]["Row"];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
  message: "must be a team id",
});
const interval = z.enum(["month", "year"]).default("month");

/** What a link can buy, as POST /api/billing/checkouts takes it. */
const itemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("plan"),
    plan: z.enum(["pro", "business"]),
    interval,
  }),
  z.strictObject({
    kind: z.literal("team_plan"),
    teamId: uuid,
    seats: z.number().int().min(MIN_TEAM_SEATS).max(MAX_TEAM_SEATS),
    plan: z.enum(["team", "team_business"]).default("team"),
    interval,
  }),
  z.strictObject({
    kind: z.literal("blocks"),
    blocks: z.number().int().min(1),
    resource: z.enum(["requests", "pages"]).default("requests"),
    teamId: uuid.optional(),
  }),
  z.strictObject({
    kind: z.literal("monthly_blocks"),
    blocks: z.number().int().min(1),
    resource: z.enum(["requests", "pages", "domains"]).default("requests"),
    teamId: uuid.optional(),
  }),
  z.strictObject({
    kind: z.literal("overage"),
    resource: z.enum(["requests", "pages"]).default("requests"),
    teamId: uuid.optional(),
  }),
]);

export type CheckoutItem = z.infer<typeof itemSchema>;

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
export function itemTeamId(item: CheckoutItem): string | null {
  return "teamId" in item && item.teamId ? item.teamId : null;
}

const NOUNS = {
  requests: ["block of 25,000 requests", "blocks of 25,000 requests"],
  pages: ["block of 1,000 parsed pages", "blocks of 1,000 parsed pages"],
  domains: ["extra custom domain", "extra custom domains"],
} as const;

/** One sentence that says what the link buys, for the asker and the person. */
export function checkoutSummary(item: CheckoutItem): string {
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
      return `${item.blocks} monthly ${item.blocks === 1 ? one : many} in all for ${team}, renewing with the plan.`;
    }
    case "overage":
      return `Overage for ${team}'s ${item.resource === "pages" ? "parsed pages" : "requests"}, billed for what is used past the plan, up to its monthly maximum.`;
  }
}

/** A checkout link as the routes answer it. The url is only there while it is open. */
export interface CheckoutLinkView {
  id: string;
  status: "open" | "paid" | "expired";
  kind: BillingCheckoutKind;
  summary: string;
  item: CheckoutItem;
  teamId: string | null;
  url: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
}

/** Who asked: the person, and the key or agent registration they asked with. */
export interface CheckoutAsker {
  userId: string;
  keyId?: string;
  agentRegistrationId?: string | null;
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

function view(row: Row): CheckoutLinkView {
  const item = itemSchema.safeParse(row.item);
  const status: CheckoutLinkView["status"] =
    row.status === "paid" ? "paid" : row.status === "expired" ? "expired" : "open";
  return {
    id: row.id,
    status,
    kind: row.kind,
    summary: item.success ? checkoutSummary(item.data) : "",
    item: item.success ? item.data : (row.item as unknown as CheckoutItem),
    teamId: row.team_id,
    url: status === "open" ? row.url : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
  };
}

/** Opens the Polar checkout through the dashboard's own creator for the item. */
async function openCheckout(
  item: CheckoutItem,
  userId: string,
  successUrl: string
): Promise<CheckoutSession> {
  const options = { successUrl };
  if (item.kind === "plan") {
    return createPlanCheckoutSession(userId, item.plan, item.interval, options);
  }
  if (item.kind === "team_plan") {
    return createTeamCheckoutSession(
      userId,
      item.teamId,
      item.seats,
      item.plan,
      item.interval,
      options
    );
  }
  const teamId = itemTeamId(item);
  const account: CapacityAccount = teamId ? { kind: "team", teamId } : { kind: "user", userId };
  await assertCanManage(account, userId);
  if (item.kind === "blocks") {
    return createOneTimeBlocksCheckoutSession(account, userId, item.blocks, item.resource, options);
  }
  if (item.kind === "monthly_blocks") {
    return createMonthlyBlocksCheckoutSession(account, userId, item.blocks, item.resource, options);
  }
  return createOverageCheckoutSession(account, userId, item.resource, options);
}

const COLUMNS =
  "id, user_id, team_id, created_by, requested_by_key, requested_by_agent, kind, item, polar_checkout_id, url, status, created_at, expires_at, paid_at";

/**
 * Takes a slot for the link (the limits), opens the Polar checkout and
 * records it. Throws CheckoutLinkError for the limits, and whatever the
 * checkout creators throw (their BillingActionError, TeamBillingError and
 * CapacityError, a Polar error) for the routes to answer.
 */
export async function createCheckoutLink(
  asker: CheckoutAsker,
  item: CheckoutItem
): Promise<CheckoutLinkView> {
  const admin = createAdminClient();
  const teamId = itemTeamId(item);
  // A member's key never takes a slot on the team: only its owner may buy for it.
  if (teamId) await assertCanManage({ kind: "team", teamId }, asker.userId);

  const { data: reservedId, error: reserveError } = await admin.rpc("reserve_billing_checkout", {
    p_user_id: teamId ? null : asker.userId,
    p_team_id: teamId,
    p_created_by: asker.userId,
    p_key_id: asker.keyId ?? null,
    p_agent_id: asker.agentRegistrationId ?? null,
    p_kind: item.kind,
    p_item: item as unknown as Json,
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
  const id = reservedId as string;

  let session: CheckoutSession;
  try {
    session = await openCheckout(item, asker.userId, `${polarAppUrl()}${CHECKOUT_COMPLETE_PATH}`);
  } catch (error) {
    // A refused or failed checkout leaves no link behind.
    await admin.from("billing_checkouts").delete().eq("id", id).eq("status", "creating");
    throw error;
  }
  if (!session.id) {
    // A team's open session cached before ids were stored: it cannot be followed.
    await admin.from("billing_checkouts").delete().eq("id", id).eq("status", "creating");
    throw new CheckoutLinkError(
      "checkout_in_progress",
      "A checkout for this team is already open in the dashboard. Finish it there, or try again once it expires.",
      409
    );
  }

  const expiresAt = session.expiresAt ?? new Date(Date.now() + FALLBACK_EXPIRY_MS).toISOString();
  const { data: written, error: writeError } = await admin
    .from("billing_checkouts")
    .update({
      polar_checkout_id: session.id,
      url: session.url,
      status: "open",
      expires_at: expiresAt,
    })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle<Row>();
  if (!writeError && written) return view(written);

  // A team's open session is reused, as the dashboard reuses it, so another
  // link may already follow it: that link is the answer, with what it buys now.
  if (writeError?.code === "23505") {
    await admin.from("billing_checkouts").delete().eq("id", id).eq("status", "creating");
    const { data: existing, error: readError } = await admin
      .from("billing_checkouts")
      .update({ item: item as unknown as Json, kind: item.kind, url: session.url })
      .eq("polar_checkout_id", session.id)
      .eq("created_by", asker.userId)
      .select(COLUMNS)
      .maybeSingle<Row>();
    if (readError) throw readError;
    if (existing) return view(existing);
  }
  throw writeError ?? new Error("The checkout link was not recorded");
}

/**
 * A link for the person who asked for it (any of their keys, agents or
 * sessions), or null. One still open past its expiry is settled from
 * Polar's own state first: a checkout paid before it expired is paid even
 * when its webhook has not arrived yet.
 */
export async function getCheckoutLink(
  id: string,
  userId: string
): Promise<CheckoutLinkView | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("billing_checkouts")
    .select(COLUMNS)
    .eq("id", id)
    .eq("created_by", userId)
    .neq("status", "creating")
    .maybeSingle<Row>();
  if (error) throw error;
  if (!data) return null;
  if (data.status !== "open" || Date.parse(data.expires_at) > Date.now()) return view(data);
  const settled = await settleExpired(data);
  return view(settled);
}

/** Settles an open link past its expiry from Polar's state of the checkout. */
async function settleExpired(row: Row): Promise<Row> {
  let polarStatus: string | null = null;
  try {
    const checkout = await createPolarClient().checkouts.get(row.polar_checkout_id as string);
    polarStatus = asNonEmptyString((checkout as { status?: unknown }).status);
  } catch (error) {
    // Asked again on the next read; a read is never failed for it.
    console.warn("[checkout-links] could not read a checkout from Polar", {
      id: row.id,
      error: loggablePolarError(error),
    });
    return row;
  }
  // Confirmed: the payment is being processed, and its webhook settles it.
  if (polarStatus === "confirmed" || polarStatus === "open") return row;
  const next: BillingCheckoutStatus = polarStatus === "succeeded" ? "paid" : "expired";
  const updated = await markStatus({ id: row.id }, next);
  return updated ?? row;
}

/**
 * Moves a link to paid (from open, expired or creating: paid wins, since a
 * payment confirmed before expiry can arrive after it) or to expired (from
 * open only). Idempotent: a redelivery finds nothing left to change.
 */
async function markStatus(
  where: { id: string } | { polarCheckoutId: string },
  status: "paid" | "expired"
): Promise<Row | null> {
  const admin = createAdminClient();
  let query = admin
    .from("billing_checkouts")
    .update(
      status === "paid"
        ? { status: "paid", paid_at: new Date().toISOString() }
        : { status: "expired" }
    );
  query =
    "id" in where ? query.eq("id", where.id) : query.eq("polar_checkout_id", where.polarCheckoutId);
  query =
    status === "paid"
      ? query.in("status", ["creating", "open", "expired"])
      : query.eq("status", "open");
  const { data, error } = await query.select(COLUMNS);
  if (error) throw error;
  return (data as Row[] | null)?.[0] ?? null;
}

const ACTIVE_SUBSCRIPTION = new Set(["active", "trialing"]);

/**
 * The Polar webhook's part: a paid order or a live subscription that came
 * from a link's checkout marks the link paid, and a checkout Polar reports
 * succeeded or expired settles it too. Every other event, and every
 * checkout no link follows, changes nothing.
 */
export async function settleCheckoutLinkFromWebhook(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  if (eventType === "order.paid") {
    const checkoutId = asNonEmptyString(data.checkout_id);
    if (checkoutId) await markStatus({ polarCheckoutId: checkoutId }, "paid");
    return;
  }
  if (
    eventType === "subscription.created" ||
    eventType === "subscription.active" ||
    eventType === "subscription.updated"
  ) {
    const checkoutId = asNonEmptyString(data.checkout_id);
    const status = asNonEmptyString(data.status);
    if (checkoutId && status && ACTIVE_SUBSCRIPTION.has(status)) {
      await markStatus({ polarCheckoutId: checkoutId }, "paid");
    }
    return;
  }
  if (eventType === "checkout.updated" || eventType === "checkout.expired") {
    const checkoutId = asNonEmptyString(data.id);
    const status = asNonEmptyString(data.status);
    if (!checkoutId) return;
    if (status === "succeeded") await markStatus({ polarCheckoutId: checkoutId }, "paid");
    else if (status === "expired") await markStatus({ polarCheckoutId: checkoutId }, "expired");
  }
}
