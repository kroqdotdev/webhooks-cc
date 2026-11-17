import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "./database";
import { serverSupabaseUrl, sessionCookieName } from "./session-cookie";

export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  // Over the private network, under the browser's cookie name (session-cookie.ts).
  return createServerClient<Database>(
    serverSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: sessionCookieName() },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Read-only in a Server Component. Only route handlers use this
            // client today, and they can set cookies, so a refreshed session
            // is written back by the route that refreshed it.
          }
        },
      },
    }
  );
}
