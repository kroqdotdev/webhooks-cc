import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import { createAdminClient } from "./admin";
import { byteaToBuffer } from "./destinations";

/**
 * Google accounts connected for Sheets destinations (migration 00068). The
 * refresh token is stored encrypted (AES-GCM, SIGNING_SECRET_KEY) and only
 * ever leaves this module to call Google.
 */

export interface GoogleConnection {
  id: string;
  email: string | null;
  createdAt: number;
}

type Row = {
  id: string;
  google_email: string | null;
  created_at: string;
  refresh_token_encrypted: string;
};

export async function listGoogleConnections(userId: string): Promise<GoogleConnection[]> {
  const { data, error } = await createAdminClient()
    .from("google_connections")
    .select("id, google_email, created_at")
    .eq("user_id", userId)
    .order("created_at");
  if (error) throw error;
  return ((data ?? []) as Omit<Row, "refresh_token_encrypted">[]).map((row) => ({
    id: row.id,
    email: row.google_email,
    createdAt: Date.parse(row.created_at),
  }));
}

/** Saves a connection; connecting the same Google account again replaces its token. */
export async function saveGoogleConnection(
  userId: string,
  account: { sub: string; email: string | null; refreshToken: string; scopes: string }
): Promise<GoogleConnection> {
  const encrypted = `\\x${encryptSigningSecret(account.refreshToken).toString("hex")}`;
  const { data, error } = await createAdminClient()
    .from("google_connections")
    .upsert(
      {
        user_id: userId,
        google_sub: account.sub,
        google_email: account.email,
        refresh_token_encrypted: encrypted,
        scopes: account.scopes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,google_sub" }
    )
    .select("id, google_email, created_at")
    .single<Omit<Row, "refresh_token_encrypted">>();
  if (error) throw error;
  return { id: data.id, email: data.google_email, createdAt: Date.parse(data.created_at) };
}

/** The connection's refresh token, when it belongs to the user. */
export async function googleRefreshToken(
  userId: string,
  connectionId: string
): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const { data, error } = await createAdminClient()
    .from("google_connections")
    .select("refresh_token_encrypted")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle<{ refresh_token_encrypted: string }>();
  if (error) throw error;
  return data ? decryptSigningSecret(byteaToBuffer(data.refresh_token_encrypted)) : null;
}

/** Removes the connection; returns its refresh token so the caller can revoke it. */
export async function deleteGoogleConnection(
  userId: string,
  connectionId: string
): Promise<string | null> {
  const token = await googleRefreshToken(userId, connectionId);
  if (token === null) return null;
  const { error } = await createAdminClient()
    .from("google_connections")
    .delete()
    .eq("id", connectionId)
    .eq("user_id", userId);
  if (error) throw error;
  return token;
}

/** A connection's refresh token by id alone, for the worker; null when it is gone. */
/** A connection's refresh token, only when it belongs to `userId` (the endpoint's owner). */
export async function googleRefreshTokenById(
  connectionId: string,
  userId: string
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("google_connections")
    .select("refresh_token_encrypted")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle<{ refresh_token_encrypted: string }>();
  if (error) throw error;
  return data ? decryptSigningSecret(byteaToBuffer(data.refresh_token_encrypted)) : null;
}
