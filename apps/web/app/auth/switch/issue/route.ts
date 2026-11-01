import { NextResponse } from "next/server";
import { auditUserAction } from "@/lib/audit";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { TICKET_LIFETIME_MS, isNonceHash, sealTicket } from "@/lib/site-switch";
import { otherSite, siteForHost, siteOrigin, twoSites } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Switches per account per hour: far above any person's, well below a script's. */
const SWITCHES_PER_HOUR = 30;

/**
 * GET /auth/switch/issue?n=&next=: the middle stop (lib/site-switch.ts), on
 * the site switched from. With a session here, makes a ticket that signs the
 * same account in on the other site, for the browser holding the nonce `n`
 * is the hash of. Without one, or when anything fails, the browser goes on
 * to the other site's page signed out, where an app page asks it to sign in.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = resolveRedirectBase(request, url.origin);
  const here = siteForHost(new URL(base).host);
  const to = otherSite(here);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const nonce = url.searchParams.get("n");
  const signedOut = () => {
    const response = NextResponse.redirect(`${siteOrigin(to)}${next}`, 303);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  if (!twoSites() || !isNonceHash(nonce)) return signedOut();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return signedOut();

  const limit = await checkRateLimitByKeyWithInfo(
    `site-switch:${user.id}`,
    SWITCHES_PER_HOUR,
    60 * 60 * 1000
  );
  if (limit.response) return signedOut();

  try {
    // A magic link's token for the account, made and kept here: nothing is
    // sent, and the token only travels sealed in the ticket.
    const { data, error } = await createAdminClient().auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) throw error ?? new Error("generateLink returned no token");

    const ticket = sealTicket({
      tokenHash,
      nonce,
      to,
      next,
      expires: Date.now() + TICKET_LIFETIME_MS,
    });
    await auditUserAction(request, user.id, {
      action: "account.site_switch",
      status: 200,
      metadata: { to },
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
      metadata: { to },
    });
    return signedOut();
  }
}
