import { NextResponse } from "next/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { clearSwitchCookie, nonceMatches, openTicket, switchNonceOf } from "@/lib/site-switch";
import { siteForHost } from "@/lib/site";
import { rememberHomeSite } from "@/lib/supabase/home-site";
import { createClient } from "@/lib/supabase/server";

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

  const ticket = openTicket(url.searchParams.get("t") ?? "");
  if (!ticket || ticket.to !== here || !nonceMatches(switchNonceOf(request), ticket.nonce)) {
    return done(`${base}/login?error=switch_failed`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: ticket.tokenHash,
  });
  if (error || !data?.user) return done(`${base}/login?error=switch_failed`);

  await rememberHomeSite(data.user.id, here);
  return done(`${base}${sanitizeNextPath(ticket.next)}`);
}
