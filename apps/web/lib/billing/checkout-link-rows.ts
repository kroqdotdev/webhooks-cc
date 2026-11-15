/**
 * The checkout link rows the billing webhooks change directly (migration
 * 00104). Kept apart from lib/billing/checkout-links.ts, which imports the
 * billing modules, so those modules can call these without an import cycle.
 */
import { createAdminClient } from "@/lib/supabase/admin";
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
 * Marks the links whose Polar session made a purchase the webhook then
 * undid: a subscription ended as the account's second plan or add-on of its
 * kind, or an order whose extra domains had nothing left to go on (both
 * refunded, or kept as one-time blocks): superseded, never paid. From any
 * status: an order.paid that arrived first may already have marked them
 * paid. paid_at keeps when the payment came, for the cleanup. Idempotent.
 * Called before the subscription is revoked: a redelivery after a revoke
 * reads it as ended and never comes back here.
 *
 * Those are the links that follow the session (`checkoutId`), and the link
 * the session's `metadata` names, which may never have stored the session's
 * id (the write after minting failed): that one unless another session was
 * moved onto it or it was let go of a moved session (detached_at), the same
 * rule that keeps such a link from being paid through the metadata.
 */
export async function supersedeCheckoutLinks(
  checkoutId: string | null,
  metadata?: unknown
): Promise<void> {
  const named = checkoutLinkNamedBy(metadata);
  if (!checkoutId && !named) return;
  const admin = createAdminClient();
  const paidAt = new Date().toISOString();
  if (checkoutId) {
    const { error } = await admin
      .from("billing_checkouts")
      .update({ status: "superseded" })
      .eq("polar_checkout_id", checkoutId)
      .neq("status", "superseded");
    if (error) throw error;
    const { error: stampError } = await admin
      .from("billing_checkouts")
      .update({ paid_at: paidAt })
      .eq("polar_checkout_id", checkoutId)
      .is("paid_at", null);
    if (stampError) throw stampError;
  }
  if (named && (!checkoutId || POLAR_CHECKOUT_ID.test(checkoutId))) {
    let query = admin
      .from("billing_checkouts")
      .update({
        status: "superseded",
        ...(checkoutId ? { polar_checkout_id: checkoutId } : {}),
      })
      .eq("id", named)
      .neq("status", "superseded")
      .is("detached_at", null);
    query = checkoutId
      ? query.or(`polar_checkout_id.is.null,polar_checkout_id.eq."${checkoutId}"`)
      : query.is("polar_checkout_id", null);
    const { data, error } = await query.select("id, paid_at");
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
  if (!checkoutId) return;
  const { error } = await createAdminClient()
    .from("billing_checkouts")
    .update({ mismatch })
    .eq("polar_checkout_id", checkoutId);
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
