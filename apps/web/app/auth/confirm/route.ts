import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { nextFromRedirectTo, resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";

/**
 * Email link landing for signup confirmation and password recovery.
 *
 * The GoTrue email templates (public/email-templates/*.html) link here with a
 * `token_hash` instead of GoTrue's default /auth/v1/verify link, so the
 * verification happens server-side via verifyOtp and the session lands in
 * cookies through the server client's adapter (route handlers may write
 * cookies). That makes the link work in any browser, not only the one that
 * started the flow, and keeps tokens out of URL fragments.
 *
 * Only the types our templates mint are accepted: "email" covers signup
 * confirmation ("signup" is GoTrue's alias for the same verification) and
 * "recovery" is the password reset, which continues on /auth/reset-password.
 */
const ALLOWED_TYPES = new Set<EmailOtpType>(["email", "signup", "recovery"]);

/** Origins a redirect_to may point at: the resolved public base, the request origin, and the configured app URL. */
function ownOrigins(base: string, origin: string): string[] {
  const origins = new Set([base, origin]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // ignore a malformed NEXT_PUBLIC_APP_URL; the other two still apply
    }
  }
  return [...origins];
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const base = resolveRedirectBase(request, origin);
  // Where to land: the sign-up form passes the login page's ?redirect= through
  // GoTrue as emailRedirectTo, which the template renders as redirect_to (so a
  // CLI-verify or agent-claim flow survives email confirmation); otherwise the
  // template's static next (/dashboard, /auth/reset-password).
  const next = nextFromRedirectTo(
    searchParams.get("redirect_to"),
    ownOrigins(base, origin),
    sanitizeNextPath(searchParams.get("next"))
  );

  if (tokenHash && type && ALLOWED_TYPES.has(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${base}${next}`);
    }
  }

  // Code, not copy: the login page maps it (see LOGIN_ERROR_CODES).
  return NextResponse.redirect(`${base}/login?error=link_invalid`);
}
