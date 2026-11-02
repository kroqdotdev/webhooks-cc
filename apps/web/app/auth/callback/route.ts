import { NextResponse } from "next/server";
import { DEFAULT_EMAIL_DOMAIN } from "@webhooks-cc/sdk/email";
import { createClient } from "@/lib/supabase/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { siteForHost } from "@/lib/site";
import { rememberHomeSite } from "@/lib/supabase/home-site";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const base = resolveRedirectBase(request, origin);

  // Validate next param to prevent open redirect
  const next = sanitizeNextPath(searchParams.get("next"));

  // Surface OAuth provider errors (e.g. user denied consent) as one of our
  // own codes; the login page only renders known codes, never provider text.
  const providerError = searchParams.get("error");
  const description = searchParams.get("error_description");
  if (providerError || description) {
    // GoTrue reports our signup hook's refusal (migration 00052) as
    // access_denied too; its message names the capture domain.
    const code = description?.includes(DEFAULT_EMAIL_DOMAIN)
      ? "capture_domain_email"
      : providerError === "access_denied"
        ? "oauth_denied"
        : "oauth_error";
    return NextResponse.redirect(`${base}/login?error=${code}`);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data.user) await rememberHomeSite(data.user.id, siteForHost(new URL(base).host));
      return NextResponse.redirect(`${base}${next}`);
    }
  }

  return NextResponse.redirect(`${base}/login?error=auth_callback_error`);
}
