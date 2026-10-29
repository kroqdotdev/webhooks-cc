import {
  clearHandoffCookie,
  handoffHash,
  handoffNonceOf,
  openBeginTicket,
} from "@/lib/integrations/google";
import { siteOrigin } from "@/lib/site";

/**
 * GET /api/integrations/google/handoff?ticket=: the second stop of a Google
 * connection started on mailhooks.cc, back on mailhooks.cc. Only the browser
 * that started it holds the handoff cookie; it goes on to Google's consent
 * page, anyone else back to the dashboard.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const ticket = openBeginTicket(url.searchParams.get("ticket") ?? "");
  const nonce = handoffNonceOf(request);
  const ok = ticket !== null && nonce !== null && handoffHash(nonce) === ticket.handoff;
  let location = ticket?.url ?? "";
  if (!ok) {
    const back = new URL("/dashboard", siteOrigin("mailhooks"));
    back.searchParams.set("google", "expired");
    location = back.toString();
  }
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "set-cookie": clearHandoffCookie(secure),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
