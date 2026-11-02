import { NextResponse } from "next/server";
import { resolveRedirectBase, sanitizeNextPath } from "@/lib/auth-redirect";
import { newNonce, nonceHash, switchCookie } from "@/lib/site-switch";
import { otherSite, siteForHost, siteOrigin, twoSites } from "@/lib/site";

/**
 * GET /auth/switch/start?g=&next=: carrying a session here from the other
 * site (lib/site-switch.ts). Sets the nonce cookie that ties the switch to
 * this browser, then takes the grant back to the other site, where the
 * browser is signed in, for a ticket.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const base = resolveRedirectBase(request, url.origin);
  const next = sanitizeNextPath(url.searchParams.get("next"));
  const grant = url.searchParams.get("g");
  if (!twoSites() || !grant) return NextResponse.redirect(`${base}${next}`, 303);

  const here = siteForHost(new URL(base).host);
  const nonce = newNonce();
  const issue = new URL("/auth/switch/issue", siteOrigin(otherSite(here)));
  issue.searchParams.set("g", grant);
  issue.searchParams.set("n", nonceHash(nonce));
  issue.searchParams.set("next", next);

  const response = NextResponse.redirect(issue.toString(), 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.append("set-cookie", switchCookie(nonce, base.startsWith("https:")));
  return response;
}
