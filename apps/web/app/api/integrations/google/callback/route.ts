import { auditUserAction } from "@/lib/audit";
import { publicEnv } from "@/lib/env";
import {
  browserHash,
  browserNonceOf,
  clearBrowserCookie,
  exchangeCode,
  googleConfig,
  GoogleError,
  openState,
  sealFinishTicket,
} from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { siteOrigin } from "@/lib/site";
import { saveGoogleConnection } from "@/lib/supabase/google-connections";

/**
 * GET /api/integrations/google/callback: where Google sends the browser
 * back. The state says who started it and where to return; the connection
 * is saved for that user, and the browser goes back with ?google=connected
 * (or an error).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = openState(url.searchParams.get("state") ?? "");
  // Back to the site the flow started on (mailhooks.cc goes through begin).
  const appUrl = (
    state?.site === "mailhooks" ? siteOrigin("mailhooks") : publicEnv().NEXT_PUBLIC_APP_URL
  ).replace(/\/+$/, "");
  const secure = url.protocol === "https:";
  const back = (path: string, outcome: string) => {
    const target = new URL(path, `${appUrl}/`);
    target.searchParams.set("google", outcome);
    return new Response(null, {
      status: 303,
      headers: { location: target.toString(), "set-cookie": clearBrowserCookie(secure) },
    });
  };
  if (!state) return back("/dashboard", "expired");
  // The browser that finishes must be the one that started (a consent URL
  // someone else made would otherwise link your Google account to theirs).
  const nonce = browserNonceOf(request);
  if (!nonce || browserHash(nonce) !== state.browser) return back(state.returnTo, "expired");
  if (url.searchParams.get("error")) return back(state.returnTo, "cancelled");
  const code = url.searchParams.get("code");
  const config = googleConfig();
  if (!code || !config) return back(state.returnTo, "failed");
  if (state.site === "mailhooks" && state.handoff) {
    // Saved on mailhooks.cc, for the browser that started there only.
    const finish = new URL("/api/integrations/google/finish", siteOrigin("mailhooks"));
    finish.searchParams.set("ticket", sealFinishTicket(code, state));
    return new Response(null, {
      status: 303,
      headers: {
        location: finish.toString(),
        "set-cookie": clearBrowserCookie(secure),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  try {
    const account = await exchangeCode(config, code, state.verifier);
    const connection = await saveGoogleConnection(state.userId, account);
    await auditUserAction(request, state.userId, {
      action: "integration.google_connected",
      status: 200,
      metadata: { connectionId: connection.id },
    });
    return back(state.returnTo, "connected");
  } catch (error) {
    if (!(error instanceof GoogleError)) reportError("Google connection failed", error);
    return back(
      state.returnTo,
      error instanceof GoogleError && error.message.startsWith("Allow") ? "scope" : "failed"
    );
  }
}
