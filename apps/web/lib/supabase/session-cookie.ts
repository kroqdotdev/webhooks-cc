/**
 * Where the session cookie lives and which address the server checks it at.
 *
 * The browser talks to Supabase at its public address (NEXT_PUBLIC_SUPABASE_URL),
 * and supabase-js names the session cookie after that address's first host
 * label (`sb-<label>-auth-token`). The server reaches the same Supabase at its
 * internal gateway address (SUPABASE_URL) instead of going out through the
 * CDN in front of the public one and back, which cost hundreds of
 * milliseconds a request. A client made with the internal address would look
 * for a cookie named after that address and find nobody signed in, so every
 * client names the cookie explicitly, after the public address, through this
 * one function.
 */

/** The session cookie's name, as supabase-js derives it from the public address. */
export function sessionCookieName(publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): string {
  if (!publicUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  return `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token`;
}

/** The address server code reaches Supabase at: the internal one when set. */
export function serverSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  return url;
}
