import { extractBearerToken } from "@/lib/api-auth";
import { owesSecondFactor } from "@/lib/mfa-session";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Whether this session still owes the authenticator code. The browser's own
 * reading (GoTrue's assurance level) does not know about sessions a site
 * switch carried the second factor to (migration 00088), so the code prompt
 * asks here before it shows. Takes a session that owes the code, which every
 * other session route refuses.
 */
export async function GET(request: Request) {
  const token = extractBearerToken(request);
  if (!token || token.startsWith("whcc_")) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const {
    data: { user },
    error,
  } = await createAdminClient().auth.getUser(token);
  if (error || !user) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json(
    { owesCode: await owesSecondFactor(user, token) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
