import { validateApiKeyWithMetadata } from "@/lib/supabase/api-keys";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Who a CLI connecting to the edge is: the `whcc_` key (or agent token) it
 * sent, checked as every API route checks one. Sharing needs a real account
 * with a confirmed email: a pre-claim agent token has no user, and a guest
 * has no key at all.
 */

export const SUSPENDED =
  "Sharing is suspended on this account. Write to support@webhooks.cc if this is a mistake.";

export type EdgeAccount =
  { userId: string; keyId: string | null; email: string } | { error: string; status: number };

export async function accountForKey(apiKey: unknown): Promise<EdgeAccount> {
  if (typeof apiKey !== "string" || !apiKey.startsWith("whcc_") || apiKey.length > 200)
    return { error: "That API key does not work. Run `whk auth login`.", status: 401 };
  const found = await validateApiKeyWithMetadata(apiKey);
  if (!found) return { error: "That API key does not work. Run `whk auth login`.", status: 401 };
  if (found.userId === null)
    return {
      error: "Sharing needs an account. Claim this agent into one first.",
      status: 403,
    };
  const { data, error } = await createAdminClient().auth.admin.getUserById(found.userId);
  if (error || !data.user) return { error: "That account is gone.", status: 401 };
  if (!data.user.email_confirmed_at)
    return { error: "Confirm your email address first.", status: 403 };
  const { data: row, error: rowError } = await createAdminClient()
    .from("users")
    .select("tunnels_suspended")
    .eq("id", found.userId)
    .maybeSingle();
  if (rowError) throw rowError;
  if (!row) return { error: "That account is gone.", status: 401 };
  if (row.tunnels_suspended) return { error: SUSPENDED, status: 403 };
  return { userId: found.userId, keyId: found.keyId ?? null, email: data.user.email ?? "" };
}
