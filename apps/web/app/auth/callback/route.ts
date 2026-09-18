import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { SIGNUP_SIGNAL_COOKIE, SIGNUP_SIGNAL_COOKIE_OPTIONS } from "@/lib/signup-signal";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const base = resolveRedirectBase(request, origin);

  // Validate next param to prevent open redirect
  const next = sanitizeNextPath(searchParams.get("next"));

  // Surface OAuth provider errors (e.g. user denied consent) as one of our
  // own codes; the login page only renders known codes, never provider text.
  const providerError = searchParams.get("error");
  if (providerError || searchParams.get("error_description")) {
    const code = providerError === "access_denied" ? "oauth_denied" : "oauth_error";
    return NextResponse.redirect(`${base}/login?error=${code}`);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const response = NextResponse.redirect(`${base}${next}`);
      // OAuth creates the account during this exchange, so a fresh created_at
      // here means this sign-in is the signup.
      const createdAt = Date.parse(data.user?.created_at ?? "");
      if (Number.isFinite(createdAt) && Date.now() - createdAt < 60_000) {
        response.cookies.set(SIGNUP_SIGNAL_COOKIE, "1", SIGNUP_SIGNAL_COOKIE_OPTIONS);
      }
      return response;
    }
  }

  return NextResponse.redirect(`${base}/login?error=auth_callback_error`);
}
