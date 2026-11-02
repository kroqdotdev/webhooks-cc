import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/audit";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import {
  TICKET_LIFETIME_MS,
  isNonceHash,
  openGrant,
  sealTicket,
  switchKeyConfigured,
} from "@/lib/site-switch";
import { otherSite, siteForHost, siteOrigin, twoSites } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Tickets per account per hour: far above any person's, well below a script's. */
const SWITCHES_PER_HOUR = 30;

/**
 * GET /auth/switch/issue?g=&n=&next=: on the site switched from
 * (lib/site-switch.ts). Only for the account the grant names, whose session
 * this browser holds here: makes a ticket that signs it in on the other
 * site, for the browser holding the nonce `n` is the hash of. Anything else
 * ends on the other site's sign-in page, nothing made.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = resolveRedirectBase(request, url.origin);
  const here = siteForHost(new URL(base).host);
  const to = otherSite(here);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const nonce = url.searchParams.get("n");
  const refused = () => {
    const login = new URL("/login", siteOrigin(to));
    login.searchParams.set("error", "switch_failed");
    login.searchParams.set("redirect", next);
    const response = NextResponse.redirect(login.toString(), 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  };
  if (!twoSites() || !isNonceHash(nonce) || !switchKeyConfigured()) return refused();

  // A grant the signed-in page asked for, for the account signed in here.
  const grant = openGrant(url.searchParams.get("g") ?? "");
  if (!grant) return refused();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || user.id !== grant.userId) return refused();

  const limit = await checkRateLimitByKeyWithInfo(
    `site-switch:${user.id}`,
    SWITCHES_PER_HOUR,
    60 * 60 * 1000
  );
  if (limit.response) return refused();

  try {
    // A magic link's token for the account, made and kept here: nothing is
    // sent, and the token only travels sealed in the ticket.
    const { data, error } = await createAdminClient().auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) throw error ?? new Error("generateLink returned no token");
    // The account was deleted meanwhile and GoTrue made a new one for the
    // address: nothing to carry over.
    if (data.user?.id !== user.id) throw new Error("generateLink answered for another account");

    const ticket = sealTicket({
      tokenHash,
      userId: user.id,
      nonce,
      to,
      next,
      expires: Date.now() + TICKET_LIFETIME_MS,
      consent: grant.consent,
    });
    await auditUserAction(request, user.id, {
      action: "account.site_switch",
      status: 200,
      metadata: { to, stage: "issued" },
    });
    const finish = new URL("/auth/switch/finish", siteOrigin(to));
    finish.searchParams.set("t", ticket);
    const response = NextResponse.redirect(finish.toString(), 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (error) {
    reportError("Could not carry a session to the other site", error);
    await auditUserAction(request, user.id, {
      action: "account.site_switch",
      status: 500,
      metadata: { to, stage: "issued" },
    });
    return refused();
  }
}
