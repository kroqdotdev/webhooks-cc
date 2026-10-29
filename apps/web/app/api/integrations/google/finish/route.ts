import { auditUserAction } from "@/lib/audit";
import {
  clearHandoffCookie,
  exchangeCode,
  googleConfig,
  GoogleError,
  handoffHash,
  handoffNonceOf,
  openFinishTicket,
} from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { siteOrigin } from "@/lib/site";
import { saveGoogleConnection } from "@/lib/supabase/google-connections";

/**
 * GET /api/integrations/google/finish?ticket=: the end of a Google
 * connection started on mailhooks.cc, back on mailhooks.cc. The connection
 * is saved only for the browser holding the handoff cookie its start set,
 * so nobody can finish someone else's flow, or have someone else finish
 * theirs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const ticket = openFinishTicket(url.searchParams.get("ticket") ?? "");
  const back = (path: string, outcome: string) => {
    const target = new URL(path, `${siteOrigin("mailhooks")}/`);
    target.searchParams.set("google", outcome);
    return new Response(null, {
      status: 303,
      headers: {
        location: target.toString(),
        "set-cookie": clearHandoffCookie(secure),
        "cache-control": "no-store",
      },
    });
  };
  if (!ticket) return back("/dashboard", "expired");
  const nonce = handoffNonceOf(request);
  if (!nonce || handoffHash(nonce) !== ticket.state.handoff) {
    return back(ticket.state.returnTo, "expired");
  }
  const config = googleConfig();
  if (!config) return back(ticket.state.returnTo, "failed");
  try {
    const account = await exchangeCode(config, ticket.code, ticket.state.verifier);
    const connection = await saveGoogleConnection(ticket.state.userId, account);
    await auditUserAction(request, ticket.state.userId, {
      action: "integration.google_connected",
      status: 200,
      metadata: { connectionId: connection.id },
    });
    return back(ticket.state.returnTo, "connected");
  } catch (error) {
    if (!(error instanceof GoogleError)) reportError("Google connection failed", error);
    return back(
      ticket.state.returnTo,
      error instanceof GoogleError && error.message.startsWith("Allow") ? "scope" : "failed"
    );
  }
}
