import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timedFetch } from "./call-timeout";
import type { Database } from "./database";

let _admin: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (_admin) return _admin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  _admin = createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: timedFetch },
  });

  return _admin;
}
