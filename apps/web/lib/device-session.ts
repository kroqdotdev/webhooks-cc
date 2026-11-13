import { createClient } from "@/lib/supabase/server";
import { owesSecondFactor } from "@/lib/mfa-session";

/**
 * The signed-in person behind a device login's approval page: a browser
 * session (never an API key) that has passed the account's two-factor sign-in
 * when it has one. Approving mints a key that reads everything, and the page
 * shows where a login came from, so an aal1 session of an account with an
 * authenticator gets neither.
 */
export async function deviceApprover(): Promise<
  { userId: string; email: string | null } | { error: Response }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session || (await owesSecondFactor(user, session.access_token))) {
    return {
      error: Response.json({ error: "Enter your two-factor code first." }, { status: 401 }),
    };
  }
  return { userId: user.id, email: user.email ?? null };
}
