import { randomBytes } from "node:crypto";
import { createAdminClient } from "./admin";
import type { Json } from "./database";
import { getRequestByIdForUser } from "./requests";
import {
  buildShareSnapshot,
  MAX_ACTIVE_SHARES,
  parseShareSnapshot,
  SHARE_TOKEN_PATTERN,
  type ShareExpiryDays,
  type ShareSnapshot,
} from "@/lib/request-share";

const DAY_MS = 86_400_000;

export interface RequestShare {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  redactedHeaders: string[];
}

export type CreateShareResult =
  | { ok: true; share: RequestShare; endpointId: string }
  | { ok: false; error: "not_found" | "email" | "not_owner" | "limit" };

/** 128 random bits, URL-safe: 22 characters. */
export function generateShareToken(): string {
  return randomBytes(16).toString("base64url");
}

function toShare(row: {
  id: string;
  token: string;
  created_at: string;
  expires_at: string;
  snapshot: Json;
}): RequestShare {
  return {
    id: row.id,
    token: row.token,
    createdAt: Date.parse(row.created_at),
    expiresAt: Date.parse(row.expires_at),
    redactedHeaders: parseShareSnapshot(row.snapshot)?.redactedHeaders ?? [],
  };
}

/**
 * Publish a request as a snapshot. Only the endpoint's owner may: a team
 * member's link would outlive their membership, out of the owner's sight.
 * Emails are refused: an email holds addresses and message contents a link
 * should not spread.
 */
export async function createRequestShare(input: {
  userId: string;
  requestId: string;
  expiresInDays: ShareExpiryDays;
  hideSensitive: boolean;
}): Promise<CreateShareResult> {
  const request = await getRequestByIdForUser(input.userId, input.requestId);
  if (!request) return { ok: false, error: "not_found" };
  if (request.kind === "email") return { ok: false, error: "email" };

  const admin = createAdminClient();
  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("user_id")
    .eq("id", request.endpointId)
    .maybeSingle();
  if (endpointError) throw endpointError;
  if (!endpoint || endpoint.user_id !== input.userId) return { ok: false, error: "not_owner" };

  const now = new Date();
  const { count, error: countError } = await admin
    .from("request_shares")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .gt("expires_at", now.toISOString());
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_ACTIVE_SHARES) return { ok: false, error: "limit" };

  const snapshot = buildShareSnapshot(request, { hideSensitive: input.hideSensitive });
  const { data, error } = await admin
    .from("request_shares")
    .insert({
      token: generateShareToken(),
      user_id: input.userId,
      endpoint_id: request.endpointId,
      request_id: request.id,
      snapshot: snapshot as unknown as Json,
      expires_at: new Date(now.getTime() + input.expiresInDays * DAY_MS).toISOString(),
    })
    .select("id, token, created_at, expires_at, snapshot")
    .single();
  if (error) throw error;
  return { ok: true, share: toShare(data), endpointId: request.endpointId };
}

/** The user's live links for one request, newest first. */
export async function listRequestShares(
  userId: string,
  requestId: string
): Promise<RequestShare[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("request_shares")
    .select("id, token, created_at, expires_at, snapshot")
    .eq("user_id", userId)
    .eq("request_id", requestId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toShare);
}

export interface UserShare extends RequestShare {
  method: string;
  path: string;
  detectedProvider: string | null;
  detectedEvent: string | null;
  /** Null once the request is gone; the link still works. */
  requestId: string | null;
  endpointSlug: string | null;
}

/** All of the user's live links, newest first: the account page lists them for revoking. */
export async function listUserShares(userId: string): Promise<UserShare[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("request_shares")
    .select("id, token, created_at, expires_at, snapshot, endpoint_id, request_id")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = data ?? [];
  const endpointIds = [...new Set(rows.map((row) => row.endpoint_id))];
  const slugs = new Map<string, string>();
  if (endpointIds.length > 0) {
    const { data: endpoints, error: endpointsError } = await admin
      .from("endpoints")
      .select("id, slug")
      .in("id", endpointIds);
    if (endpointsError) throw endpointsError;
    for (const endpoint of endpoints ?? []) slugs.set(endpoint.id, endpoint.slug);
  }
  return rows.map((row) => {
    const snapshot = parseShareSnapshot(row.snapshot);
    return {
      ...toShare(row),
      method: snapshot?.method ?? "",
      path: snapshot?.path ?? "",
      detectedProvider: snapshot?.detectedProvider ?? null,
      detectedEvent: snapshot?.detectedEvent ?? null,
      requestId: row.request_id,
      endpointSlug: slugs.get(row.endpoint_id) ?? null,
    };
  });
}

/** Revoke one of the user's links. True when a link was deleted. */
export async function deleteRequestShare(userId: string, shareId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("request_shares")
    .delete()
    .eq("id", shareId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface SharedRequest {
  snapshot: ShareSnapshot;
  createdAt: number;
  expiresAt: number;
}

/** The snapshot behind a live link, or null for an unknown, expired or malformed one. */
export async function getSharedRequest(token: string): Promise<SharedRequest | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("request_shares")
    .select("snapshot, created_at, expires_at")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const snapshot = parseShareSnapshot(data.snapshot);
  if (!snapshot) return null;
  return {
    snapshot,
    createdAt: Date.parse(data.created_at),
    expiresAt: Date.parse(data.expires_at),
  };
}
