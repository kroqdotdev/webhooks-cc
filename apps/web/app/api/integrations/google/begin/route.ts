import { browserCookie, openBeginTicket } from "@/lib/integrations/google";
import { siteOrigin } from "@/lib/site";

/**
 * GET /api/integrations/google/begin?ticket=: the first stop of a Google
 * connection started on mailhooks.cc. On webhooks.cc, it sets the nonce
 * cookie the callback (also webhooks.cc's) checks, then sends the browser to
 * mailhooks.cc's handoff, which checks the browser before going to Google.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const sealed = url.searchParams.get("ticket") ?? "";
  const ticket = openBeginTicket(sealed);
  const next = new URL(
    ticket ? "/api/integrations/google/handoff" : "/dashboard",
    siteOrigin("mailhooks")
  );
  if (ticket) next.searchParams.set("ticket", sealed);
  else next.searchParams.set("google", "expired");
  const headers = new Headers({
    location: next.toString(),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  if (ticket) {
    headers.append("set-cookie", browserCookie(ticket.browserNonce, url.protocol === "https:"));
  }
  return new Response(null, { status: 303, headers });
}
