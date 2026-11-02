import { NextResponse } from "next/server";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { auditUserAction } from "@/lib/audit";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { reportError } from "@/lib/observability";
import {
  clearSwitchCookie,
  nonceMatches,
  openTicket,
  switchNonceOf,
  type SwitchTicket,
} from "@/lib/site-switch";
import { siteForHost } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { rememberHomeSite } from "@/lib/supabase/home-site";
import { createClient } from "@/lib/supabase/server";

/**
 * Uses up the token of a ticket this browser may not have: a session made
 * outside any cookie and revoked at once, so a copy of the ticket cannot be
 * tried again elsewhere.
 */
async function burn(ticket: SwitchTicket): Promise<void> {
  try {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const plain = createPlainClient(url, anon, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await plain.auth.verifyOtp({
      type: "magiclink",
      token_hash: ticket.tokenHash,
    });
    if (data?.session) {
      await createAdminClient().auth.admin.signOut(data.session.access_token, "local");
    }
  } catch (error) {
    reportError("Could not use up a refused site switch ticket", error);
  }
}

/**
 * GET /auth/switch/finish?t=: the last stop (lib/site-switch.ts), back on the
 * site switched to. Signs the ticket's account in here, only for the browser
 * whose nonce cookie the ticket was made for, then lands on its page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = resolveRedirectBase(request, url.origin);
  const here = siteForHost(new URL(base).host);
  const secure = base.startsWith("https:");
  const done = (location: string) => {
    const response = NextResponse.redirect(location, 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.append("set-cookie", clearSwitchCookie(secure));
    return response;
  };
  const failed = `${base}/login?error=switch_failed`;

  const ticket = openTicket(url.searchParams.get("t") ?? "");
  if (!ticket || ticket.to !== here) return done(failed);
  if (!nonceMatches(switchNonceOf(request, secure), ticket.nonce)) {
    // Not the browser the ticket was made for.
    await burn(ticket);
    await auditUserAction(request, ticket.userId, {
      action: "account.site_switch",
      status: 403,
      metadata: { to: here, stage: "refused" },
    });
    return done(failed);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: ticket.tokenHash,
  });
  if (error || !data?.user) return done(failed);

  await rememberHomeSite(data.user.id, here);
  await auditUserAction(request, data.user.id, {
    action: "account.site_switch",
    status: 200,
    metadata: { to: here, stage: "signed_in" },
  });
  return done(`${base}${sanitizeNextPath(ticket.next)}`);
}
