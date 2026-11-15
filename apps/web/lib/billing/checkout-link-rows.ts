/**
 * The checkout link rows the billing webhooks change directly (migration
 * 00104). Kept apart from lib/billing/checkout-links.ts, which imports the
 * billing modules, so those modules can call these without an import cycle.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { CHECKOUT_LINK_METADATA_KEY } from "@/lib/supabase/billing-shared";

/**
 * The checkout link a Polar session's metadata names (copied onto its order
 * and subscription), when it is a link id at all.
 */
export function checkoutLinkNamedBy(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const named = (metadata as Record<string, unknown>)[CHECKOUT_LINK_METADATA_KEY];
  return typeof named === "string" && LINK_ID.test(named) ? named : null;
}

const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLAR_CHECKOUT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a Polar event's customer is the one the link's billing account
 * pays with (the user's, or the team's). The metadata is ours, but a link
 * named there is acted on only when the payment came from its own account:
 * a session made for another customer (by hand in Polar, say) that carries
 * a link's id never pays or undoes that link. A mismatch is reported.
 */
export async function linkCustomerMatches(
  linkId: string,
  customerId: string | null
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: link, error } = await admin
    .from("billing_checkouts")
    .select("user_id, team_id")
    .eq("id", linkId)
    .maybeSingle();
  if (error) throw error;
  if (!link) return false;
  const { data: account, error: accountError } = link.team_id
    ? await admin.from("teams").select("polar_customer_id").eq("id", link.team_id).maybeSingle()
    : await admin
        .from("users")
        .select("polar_customer_id")
        .eq("id", link.user_id ?? "")
        .maybeSingle();
  if (accountError) throw accountError;
  const stored = account?.polar_customer_id ?? null;
  if (customerId !== null && stored !== null && customerId === stored) return true;
  // Each case its own words: only the last is someone else's payment.
  const what =
    customerId === null
      ? "a Polar event that names a checkout link carries no customer"
      : stored === null
        ? "a Polar event names a checkout link whose account has no Polar customer yet"
        : "a Polar session's metadata names a checkout link of another customer";
  reportError(`[checkout-links] ${what}`, undefined, { linkId });
  return false;
}

/**
 * Marks the links whose Polar session made a purchase the webhook then
 * undid: a subscription ended as the account's second plan or add-on of its
 * kind, or an order whose extra domains had nothing left to go on (both
 * refunded, or kept as one-time blocks): superseded, never paid. From any
 * status: an order.paid that arrived first may already have marked them
 * paid. paid_at keeps when the payment came, for the cleanup. Idempotent.
 * Called before the subscription is revoked: a redelivery after a revoke
 * reads it as ended and never comes back here.
 *
 * Those are the links that follow the session (`checkoutId`) or were paid
 * through it (paid_checkout_id, a session they had replaced), a link that
 * replaced it with a new session and is not paid or cancelled
 * (previous_checkout_ids), and the link the session's `metadata` names,
 * which may never have stored the session's id (the write after minting
 * failed): that one unless another session was moved onto it, it was let
 * go of a moved session (detached_at) or its asker cancelled it, the same
 * rules that keep such a link from being paid through the metadata, and
 * only when the event's `customerId` is the link account's
 * (linkCustomerMatches(), asked only once that link is found to be one).
 * A link already paid through another of its sessions is never superseded
 * here: that purchase stands, and this one is a duplicate of it. Every link
 * superseded records the session that did it in paid_checkout_id, so a
 * session it had replaced whose purchase stands can still pay it
 * (settlePaid() in checkout-links.ts).
 */
export async function supersedeCheckoutLinks(
  checkoutId: string | null,
  metadata: unknown,
  customerId: string | null
): Promise<void> {
  const named = checkoutLinkNamedBy(metadata);
  if (!checkoutId && !named) return;
  const admin = createAdminClient();
  const paidAt = new Date().toISOString();
  const safeId = checkoutId !== null && POLAR_CHECKOUT_ID.test(checkoutId);
  if (safeId) {
    // Following this session and not paid through another, or paid through this one.
    const ours = `and(polar_checkout_id.eq."${checkoutId}",paid_checkout_id.is.null),paid_checkout_id.eq."${checkoutId}"`;
    const { error } = await admin
      .from("billing_checkouts")
      .update({ status: "superseded", paid_checkout_id: checkoutId })
      .or(ours)
      .neq("status", "superseded");
    if (error) throw error;
    const { error: stampError } = await admin
      .from("billing_checkouts")
      .update({ paid_at: paidAt })
      .or(ours)
      .is("paid_at", null);
    if (stampError) throw stampError;

    // Only while the link is not paid by its own later session.
    const { error: replacedError } = await admin
      .from("billing_checkouts")
      .update({ status: "superseded", paid_at: paidAt, paid_checkout_id: checkoutId })
      .contains("previous_checkout_ids", [checkoutId])
      .in("status", ["open", "expired"])
      .is("cancelled_at", null);
    if (replacedError) throw replacedError;
  }
  if (named && (!checkoutId || safeId)) {
    // The link first, then whether the payment is its account's: a link
    // that is no candidate (settled, detached, cancelled, on another
    // session) is never reported as another customer's.
    const onSession = checkoutId
      ? `polar_checkout_id.is.null,polar_checkout_id.eq."${checkoutId}"`
      : "polar_checkout_id.is.null";
    const { data: found, error: findError } = await admin
      .from("billing_checkouts")
      .select("id")
      .eq("id", named)
      .neq("status", "superseded")
      .is("detached_at", null)
      .is("cancelled_at", null)
      .is("paid_checkout_id", null)
      .or(onSession)
      .maybeSingle();
    if (findError) throw findError;
    if (!found || !(await linkCustomerMatches(named, customerId))) return;
    const { data, error } = await admin
      .from("billing_checkouts")
      .update({
        status: "superseded",
        ...(checkoutId ? { polar_checkout_id: checkoutId, paid_checkout_id: checkoutId } : {}),
      })
      .eq("id", named)
      .neq("status", "superseded")
      .is("detached_at", null)
      .is("cancelled_at", null)
      .is("paid_checkout_id", null)
      .or(onSession)
      .select("id, paid_at");
    if (error) throw error;
    if ((data ?? []).some((row) => row.paid_at === null)) {
      const { error: stampError } = await admin
        .from("billing_checkouts")
        .update({ paid_at: paidAt })
        .eq("id", named)
        .is("paid_at", null);
      if (stampError) throw stampError;
    }
  }
}

/**
 * Lets go of a Polar session that now buys something else (a team's open
 * session moved to another plan or seat count): open links that followed it
 * no longer do, and the next time the person opens one, a session is found
 * or made for what it buys. `keep` is the link the session was moved for.
 * detached_at keeps a payment of that session from naming them through its
 * metadata, should Polar have kept the old link's name there.
 */
export async function detachCheckoutLinks(checkoutId: string, keep?: string): Promise<void> {
  let query = createAdminClient()
    .from("billing_checkouts")
    .update({ polar_checkout_id: null, expected: null, detached_at: new Date().toISOString() })
    .eq("polar_checkout_id", checkoutId)
    .eq("status", "open");
  if (keep) query = query.neq("id", keep);
  const { error } = await query;
  if (error) throw error;
}

/**
 * Records that what the links following a Polar session bought differs from
 * what they asked for in a way the order cannot show: `base`, a monthly
 * top-up paid when the account no longer had the count the session added
 * to. Their `matches` then reads false. Idempotent.
 */
export async function markCheckoutLinkMismatch(
  checkoutId: string | null,
  mismatch: "base"
): Promise<void> {
  if (!checkoutId || !POLAR_CHECKOUT_ID.test(checkoutId)) return;
  const { error } = await createAdminClient()
    .from("billing_checkouts")
    .update({ mismatch })
    // Following the session and not paid through another, or paid through it.
    .or(
      `and(polar_checkout_id.eq."${checkoutId}",paid_checkout_id.is.null),paid_checkout_id.eq."${checkoutId}"`
    );
  if (error) throw error;
}

/**
 * The overage maximum an overage checkout link was made with, for the
 * subscription its session made (null when no overage link has the session).
 */
export async function checkoutLinkOverageMax(checkoutId: string | null): Promise<number | null> {
  if (!checkoutId) return null;
  const { data, error } = await createAdminClient()
    .from("billing_checkouts")
    .select("item")
    .eq("polar_checkout_id", checkoutId)
    .eq("kind", "overage")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const item = data?.item;
  const max =
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).max
      : null;
  return typeof max === "number" ? max : null;
}
