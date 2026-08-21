import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // Validate next param to prevent open redirect
  const next = sanitizeNextPath(searchParams.get("next"));

  // Surface OAuth provider errors (e.g. user denied consent) as one of our
  // own codes; the login page only renders known codes, never provider text.
  const providerError = searchParams.get("error");
  if (providerError || searchParams.get("error_description")) {
    const code = providerError === "access_denied" ? "oauth_denied" : "oauth_error";
    return NextResponse.redirect(`${origin}/login?error=${code}`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${resolveRedirectBase(request, origin)}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
