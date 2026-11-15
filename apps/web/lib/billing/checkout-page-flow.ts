/**
 * What the checkout link page (app/checkout/[id]/page.tsx) does with the
 * answers of its two routes, apart from React so it can be tested: which
 * phase a refusal is, and the open flow (one retry while another tab makes
 * the checkout, never a redirect or a retry once the person has left the
 * page).
 */

export type ApiAnswer = { error?: string; code?: string };

/** The phases a refusal can be. */
export type RefusalPhase =
  | { kind: "wrong_account"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string; retry: "review" | "open" };

/**
 * Refusals that are for now only: a checkout another tab is still making
 * (opening), and another checkout link's checkout for the team that is
 * open until the time its message names (checkout_in_progress).
 */
const FOR_NOW = new Set(["opening", "checkout_in_progress"]);

/**
 * The phase for a refusal from either route. Only a refusal of the purchase
 * itself is "refused" (no way on but the Plan page); a refusal for now
 * (FOR_NOW), a rate limit (429) and a server failure offer Try again, which
 * goes back to the review.
 */
export function refusalPhase(
  status: number,
  result: ApiAnswer,
  fallback: string,
  retry: "review" | "open"
): RefusalPhase {
  const message = result.error ?? fallback;
  if (result.code === "wrong_account") return { kind: "wrong_account", message };
  if (status === 404) return { kind: "gone", message };
  if (status >= 500 || status === 429 || (result.code !== undefined && FOR_NOW.has(result.code))) {
    return { kind: "failed", message, retry };
  }
  return { kind: "refused", message };
}

/**
 * The phase for a review whose purchase check refused the link: for now
 * only (checkout_in_progress, with Try again), else refused.
 */
export function unavailablePhase(message: string, code: string | null | undefined): RefusalPhase {
  return code && FOR_NOW.has(code)
    ? { kind: "failed", message, retry: "review" }
    : { kind: "refused", message };
}

/**
 * What the page says under "This link has expired". A link let go of while
 * Polar never said it was unpaid (expiredReason "unsettled") may have been
 * paid, so it never says nothing was charged.
 */
export function expiredNotice(expiredReason: string | null | undefined): string {
  return expiredReason === "unsettled"
    ? "Polar had not confirmed a payment by the time it expired. If you paid, it is still applied to the account once Polar confirms it, and we have been alerted. If you did not, ask the agent or tool for a new link."
    : "Nothing was charged. If you still want it, ask the agent or tool for a new link.";
}

/** The open route's answer. */
export type OpenAnswer = ApiAnswer & {
  status?: string;
  /** An expired link's reason: "unsettled" when it may have been paid. */
  expiredReason?: string | null;
  url?: string;
  summary?: string;
  /** What the link buys, for the wording of a superseded link. */
  kind?: string | null;
  resource?: string | null;
};

/** What the open flow ends in, for the page to show. */
export type OpenOutcome =
  | { kind: "redirect"; summary: string; url: string }
  | { kind: "settled"; answer: OpenAnswer }
  | { kind: "refusal"; phase: RefusalPhase }
  | { kind: "failed" };

/**
 * Opens the link: twice at most, since another tab may be making the
 * checkout, ready in a moment. Returns null once `active()` says the person
 * left the page (checked after every wait), so a late answer never sends
 * them on to Polar from wherever they went, nor asks again.
 */
export async function runOpen(deps: {
  request: () => Promise<{ ok: boolean; status: number; answer: OpenAnswer }>;
  sleep: (ms: number) => Promise<void>;
  active: () => boolean;
  failed: string;
}): Promise<OpenOutcome | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { ok, status, answer } = await deps.request();
    if (!deps.active()) return null;
    if (ok && answer.status === "redirect" && answer.url) {
      return { kind: "redirect", summary: answer.summary ?? "", url: answer.url };
    }
    if (ok) return { kind: "settled", answer };
    if (answer.code === "opening" && attempt === 0) {
      await deps.sleep(2_000);
      if (!deps.active()) return null;
      continue;
    }
    return { kind: "refusal", phase: refusalPhase(status, answer, deps.failed, "open") };
  }
  return { kind: "failed" };
}
