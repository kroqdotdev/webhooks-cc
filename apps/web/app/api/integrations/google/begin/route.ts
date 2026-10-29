import { browserCookie, openBeginTicket } from "@/lib/integrations/google";
import { siteOrigin } from "@/lib/site";

/**
 * GET /api/integrations/google/begin?ticket=: the first stop of a Google
 * connection started on mailhooks.cc. On webhooks.cc, it sets the nonce
 * cookie the callback (also webhooks.cc's) checks, then sends the browser on
 * to Google's consent page. The ticket is sealed and lasts two minutes.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const ticket = openBeginTicket(url.searchParams.get("ticket") ?? "");
  if (!ticket) {
    const back = new URL("/dashboard", siteOrigin("mailhooks"));
    back.searchParams.set("google", "expired");
    return new Response(null, { status: 303, headers: { location: back.toString() } });
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: ticket.url,
      "set-cookie": browserCookie(ticket.browserNonce, url.protocol === "https:"),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
