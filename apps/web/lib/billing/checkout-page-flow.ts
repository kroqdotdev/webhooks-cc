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
 * The phase for a refusal from either route. Only a refusal of the purchase
 * itself is "refused" (no way on but the Plan page); a checkout another tab
 * is still making (409 opening), a rate limit (429) and a server failure are
 * for now only, so they offer Try again, which goes back to the review.
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
  if (status >= 500 || status === 429 || result.code === "opening") {
    return { kind: "failed", message, retry };
  }
  return { kind: "refused", message };
}

/** The open route's answer. */
export type OpenAnswer = ApiAnswer & {
  status?: string;
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
