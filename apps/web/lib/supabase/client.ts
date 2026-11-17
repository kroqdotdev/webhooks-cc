import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database";
import { sessionCookieName } from "./session-cookie";

let browserClient: SupabaseClient<Database> | null = null;

export function createClient(): SupabaseClient<Database> {
  if (typeof window === "undefined") {
    return createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      // Named, not derived, so the server's clients (session-cookie.ts) always agree.
      { cookieOptions: { name: sessionCookieName() } }
    );
  }

  if (!browserClient) {
    browserClient = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      // Named, not derived, so the server's clients (session-cookie.ts) always agree.
      { cookieOptions: { name: sessionCookieName() } }
    );
  }

  return browserClient;
}
