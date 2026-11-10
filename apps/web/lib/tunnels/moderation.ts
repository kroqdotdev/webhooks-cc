import { createAdminClient } from "@/lib/supabase/admin";
import { previewUrl } from "./config";
import { BUILT_IN_BLOCKS } from "./name-rules";
import type { ReportRow } from "./reports";
import { stopShares, type Stopped } from "./stops";

/*
 * What staff do about previews from the operations center (/ops/sharing):
 * see every live run, stop one or all of an account's, block names and
 * words, suspend sharing on an account, lift the new-account notice, and
 * work through reports. The routes in app/api/ops/sharing audit each action.
 */

/** A name staff may block: any DNS label, free previews' `-free` names included. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Blocked words, as the table's check allows. */
const WORD = /^[a-z0-9]{3,40}$/;

export function blockNameProblem(name: string): string | null {
  return LABEL.test(name) ? null : "A name is lowercase letters, digits and hyphens.";
}

export function blockWordProblem(word: string): string | null {
  return WORD.test(word) ? null : "A word is 3 to 40 lowercase letters and digits.";
}

export interface OpsShare {
  id: string;
  kind: "share" | "live";
  name: string | null;
  url: string | null;
  endpointId: string | null;
  free: boolean;
  user: { id: string; email: string | null };
  client: string;
  /** Where the CLI connected from (kept 90 days after a run ends). */
  clientAddress: string | null;
  keyId: string | null;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  bytes: number;
  requests: number;
}

async function emailsOf(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await createAdminClient()
    .from("users")
    .select("id, email")
    .in("id", unique);
  if (error) throw error;
  return new Map((data ?? []).map((u) => [u.id, u.email]));
}

type ShareSelect = {
  id: string;
  kind: "share" | "live";
  name: string | null;
  endpoint_id: string | null;
  free: boolean;
  user_id: string;
  client: string;
  client_address: string | null;
  key_id: string | null;
  started_at: string;
  expires_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  bytes: number;
  requests: number;
};

const SHARE_COLUMNS =
  "id, kind, name, endpoint_id, free, user_id, client, client_address, key_id, started_at, expires_at, ended_at, end_reason, bytes, requests";

async function opsShares(rows: ShareSelect[]): Promise<OpsShare[]> {
  const emails = await emailsOf(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    url: r.name ? previewUrl(r.name) : null,
    endpointId: r.endpoint_id,
    free: r.free,
    user: { id: r.user_id, email: emails.get(r.user_id) ?? null },
    client: r.client,
    clientAddress: r.client_address,
    keyId: r.key_id,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
    endedAt: r.ended_at,
    endReason: r.end_reason,
    bytes: Number(r.bytes),
    requests: Number(r.requests),
  }));
}

/** Every live run, newest first (at most 500), or one account's. */
export async function liveShares(userId?: string): Promise<OpsShare[]> {
  let query = createAdminClient()
    .from("tunnel_shares")
    .select(SHARE_COLUMNS)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(500);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  return opsShares((data ?? []) as ShareSelect[]);
}

export async function shareById(id: string): Promise<OpsShare | null> {
  const { data, error } = await createAdminClient()
    .from("tunnel_shares")
    .select(SHARE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await opsShares([data as ShareSelect]))[0];
}

export interface Blocks {
  names: { name: string; reason: string; createdAt: string }[];
  words: { word: string; reason: string; createdAt: string }[];
  builtIn: { names: string[]; words: string[] };
}

export async function blockedLists(): Promise<Blocks> {
  const admin = createAdminClient();
  const [names, words] = await Promise.all([
    admin
      .from("tunnel_blocked_names")
      .select("name, reason, created_at")
      .order("created_at", { ascending: false }),
    admin
      .from("tunnel_blocked_words")
      .select("word, reason, created_at")
      .order("created_at", { ascending: false }),
  ]);
  if (names.error) throw names.error;
  if (words.error) throw words.error;
  return {
    names: (names.data ?? []).map((n) => ({
      name: n.name,
      reason: n.reason,
      createdAt: n.created_at,
    })),
    words: (words.data ?? []).map((w) => ({
      word: w.word,
      reason: w.reason,
      createdAt: w.created_at,
    })),
    builtIn: BUILT_IN_BLOCKS,
  };
}

/**
 * Blocks a name, which stops whatever runs under it now and refuses it from
 * then on. A reservation stays on its account but can no longer be shared.
 */
export async function blockName(name: string, reason: string, staffId: string): Promise<Stopped> {
  const { error } = await createAdminClient()
    .from("tunnel_blocked_names")
    .upsert(
      { name, reason: reason.slice(0, 300), blocked_by: staffId },
      { onConflict: "name", ignoreDuplicates: true }
    );
  if (error) throw error;
  return stopShares({ name }, "blocked");
}

/** Whether a name was blocked. */
export async function unblockName(name: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("tunnel_blocked_names")
    .delete()
    .eq("name", name)
    .select("name");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Blocks a word in new names. Names kept before stay usable until staff
 * block the name itself, as the name rules say.
 */
export async function blockWord(word: string, reason: string, staffId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("tunnel_blocked_words")
    .upsert(
      { word, reason: reason.slice(0, 300), blocked_by: staffId },
      { onConflict: "word", ignoreDuplicates: true }
    );
  if (error) throw error;
}

export async function unblockWord(word: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("tunnel_blocked_words")
    .delete()
    .eq("word", word)
    .select("word");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface AccountSharing {
  userId: string;
  email: string | null;
  plan: string;
  suspended: boolean;
  noticeLifted: boolean;
  paidSince: string | null;
  live: OpsShare[];
}

export async function accountSharing(userId: string): Promise<AccountSharing | null> {
  const { data, error } = await createAdminClient()
    .from("users")
    .select("id, email, plan, tunnels_suspended, tunnel_notice_lifted, paid_since")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    userId: data.id,
    email: data.email,
    plan: data.plan,
    suspended: data.tunnels_suspended,
    noticeLifted: data.tunnel_notice_lifted,
    paidSince: data.paid_since,
    live: await liveShares(userId),
  };
}

/**
 * Suspends sharing on an account (its runs stop and new ones are refused)
 * or restores it. Null when there is no such account.
 */
export async function setSharingSuspended(
  userId: string,
  suspended: boolean
): Promise<Stopped | null> {
  const { data, error } = await createAdminClient()
    .from("users")
    .update({ tunnels_suspended: suspended })
    .eq("id", userId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) return null;
  if (!suspended) return { stopped: 0, edgeReached: true };
  return stopShares({ userId }, "suspended");
}

/**
 * Lifts the visitor notice a new paid account's previews show for their first
 * week, or puts it back. It applies to runs opened from then on. Whether the
 * account exists.
 */
export async function setNoticeLifted(userId: string, lifted: boolean): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("users")
    .update({ tunnel_notice_lifted: lifted })
    .eq("id", userId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface OpsReport {
  id: string;
  source: ReportRow["source"];
  kind: ReportRow["kind"];
  url: string;
  name: string | null;
  previewUrl: string | null;
  details: string;
  reporter: { name: string | null; email: string | null; goodFaith: boolean };
  status: ReportRow["status"];
  outcome: string | null;
  statementSentAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  owner: {
    id: string;
    email: string | null;
    suspended: boolean;
  } | null;
  /** The run behind it, with what the police need for child sexual abuse. */
  share: OpsShare | null;
  /** Whether the name is blocked now. */
  nameBlocked: boolean;
}

/**
 * Open reports (child sexual abuse first, then the newest) or the latest
 * resolved ones, at most 200.
 */
export async function reportsForOps(view: "open" | "resolved"): Promise<OpsReport[]> {
  const admin = createAdminClient();
  let query = admin.from("abuse_reports").select("*").eq("status", view).limit(200);
  query =
    view === "open"
      ? query.order("created_at", { ascending: false })
      : query.order("resolved_at", { ascending: false });
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  if (view === "open") rows.sort((a, b) => Number(b.kind === "csam") - Number(a.kind === "csam"));
  return describeReports(rows);
}

export async function reportForOps(id: string): Promise<OpsReport | null> {
  const { data, error } = await createAdminClient()
    .from("abuse_reports")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? (await describeReports([data]))[0] : null;
}

async function describeReports(rows: ReportRow[]): Promise<OpsReport[]> {
  if (rows.length === 0) return [];
  const admin = createAdminClient();
  const userIds = [...new Set(rows.flatMap((r) => (r.user_id ? [r.user_id] : [])))];
  const shareIds = [...new Set(rows.flatMap((r) => (r.share_id ? [r.share_id] : [])))];
  const names = [...new Set(rows.flatMap((r) => (r.name ? [r.name] : [])))];
  const [users, shares, blocked] = await Promise.all([
    userIds.length
      ? admin.from("users").select("id, email, tunnels_suspended").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    shareIds.length
      ? admin.from("tunnel_shares").select(SHARE_COLUMNS).in("id", shareIds)
      : Promise.resolve({ data: [], error: null }),
    names.length
      ? admin.from("tunnel_blocked_names").select("name").in("name", names)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (users.error) throw users.error;
  if (shares.error) throw shares.error;
  if (blocked.error) throw blocked.error;
  const userMap = new Map(
    ((users.data ?? []) as { id: string; email: string | null; tunnels_suspended: boolean }[]).map(
      (u) => [u.id, u]
    )
  );
  const shareMap = new Map(
    (await opsShares((shares.data ?? []) as ShareSelect[])).map((s) => [s.id, s])
  );
  const blockedSet = new Set(((blocked.data ?? []) as { name: string }[]).map((b) => b.name));
  return rows.map((r) => {
    const owner = r.user_id ? userMap.get(r.user_id) : undefined;
    return {
      id: r.id,
      source: r.source,
      kind: r.kind,
      url: r.url,
      name: r.name,
      previewUrl: r.name ? previewUrl(r.name) : null,
      details: r.details,
      reporter: { name: r.reporter_name, email: r.reporter_email, goodFaith: r.good_faith },
      status: r.status,
      outcome: r.outcome,
      statementSentAt: r.statement_sent_at,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      owner: owner
        ? { id: owner.id, email: owner.email, suspended: owner.tunnels_suspended }
        : null,
      share: r.share_id ? (shareMap.get(r.share_id) ?? null) : null,
      nameBlocked: r.name ? blockedSet.has(r.name) : false,
    };
  });
}
