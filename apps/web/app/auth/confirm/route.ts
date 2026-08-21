import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";

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

const INVALID_LINK_MESSAGE = "That link is invalid or has expired. Sign in, or request a new link.";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = sanitizeNextPath(searchParams.get("next"));
  const base = resolveRedirectBase(request, origin);

  if (tokenHash && type && ALLOWED_TYPES.has(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${base}${next}`);
    }
  }

  return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(INVALID_LINK_MESSAGE)}`);
}
