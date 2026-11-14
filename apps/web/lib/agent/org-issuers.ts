import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Organisation ID-JAG issuers a team trusts (migration 00105).
 *
 * Some organisations' AI platforms issue ID-JAG identity assertions for their
 * members under an issuer URL of the organisation's own (Claude's are
 * `https://identity.anthropic.com/issuers/<issuer-id>`, one per Claude
 * organisation, on the Team and Enterprise plans:
 * https://claude.com/docs/connectors/building/enterprise-managed-auth). A
 * team's owner adds such an issuer; a member's agent then presents the
 * member's assertion at the token endpoint (lib/agent/org-id-jag.ts).
 *
 * Which issuers may be added at all is deployment configuration:
 * AGENT_IDJAG_ORG_ISSUER_PREFIXES, https prefixes ending in "/". Empty (the
 * default, and production until announced) turns the feature off: the routes
 * answer 404, the settings section is hidden and the token endpoint treats
 * an ID-JAG like any other unknown assertion.
 */

/** Issuers one team may trust. */
export const MAX_TEAM_ISSUERS = 5;
/** Client ids one issuer row may list. */
export const MAX_ALLOWED_CLIENT_IDS = 10;
const MAX_ISSUER_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 512;

export interface TeamIdJagIssuer {
  id: string;
  issuer: string;
  allowedClientIds: string[];
  addedBy: string | null;
  createdAt: string;
}

/** The configured prefixes; empty when the feature is off. */
export function orgIssuerPrefixes(): string[] {
  return serverEnv().AGENT_IDJAG_ORG_ISSUER_PREFIXES;
}

/** True when a team may trust organisation issuers at all. */
export function orgIssuersEnabled(): boolean {
  try {
    return orgIssuerPrefixes().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether an issuer string may be trusted: an https URL exactly as written
 * (no normalisation, since `iss` is compared byte for byte), with no
 * credentials, query or fragment, under a configured prefix and longer than
 * it. Returns the reason for a person when it may not.
 */
export function checkOrgIssuer(
  value: unknown
): { ok: true; issuer: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "Give the issuer URL." };
  }
  if (value.length > MAX_ISSUER_LENGTH || /[\s\p{Cc}\p{Cf}]/u.test(value)) {
    return { ok: false, reason: "The issuer must be a URL of at most 512 characters." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "The issuer must be an https URL." };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return {
      ok: false,
      reason: "The issuer must be an https URL without credentials, query or fragment.",
    };
  }
  if (value.includes("#") || value.includes("?")) {
    return { ok: false, reason: "The issuer must be an https URL without query or fragment." };
  }
  const segments = value.slice("https://".length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "The issuer must not contain dot segments." };
  }
  const prefixes = orgIssuerPrefixes();
  if (!prefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length)) {
    return {
      ok: false,
      reason: `Only issuers under ${prefixes.join(", ")} can be trusted.`,
    };
  }
  return { ok: true, issuer: value };
}

/**
 * The client ids an issuer row may list: up to 10 strings of up to 512
 * printable characters, without duplicates. Absent means any client.
 */
export function checkAllowedClientIds(
  value: unknown
): { ok: true; clientIds: string[] } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, clientIds: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: "allowed_client_ids must be a list of client ids." };
  }
  if (value.length > MAX_ALLOWED_CLIENT_IDS) {
    return { ok: false, reason: `List at most ${MAX_ALLOWED_CLIENT_IDS} client ids.` };
  }
  const clientIds: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.trim() !== entry ||
      entry.length === 0 ||
      entry.length > MAX_CLIENT_ID_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(entry)
    ) {
      return {
        ok: false,
        reason: "Each client id must be text of 1 to 512 characters, without spaces around it.",
      };
    }
    if (!clientIds.includes(entry)) clientIds.push(entry);
  }
  return { ok: true, clientIds };
}

/** True when the issuer is under a configured prefix (a row may predate a change). */
export function issuerUnderPrefix(issuer: string): boolean {
  return orgIssuerPrefixes().some(
    (prefix) => issuer.startsWith(prefix) && issuer.length > prefix.length
  );
}

/** True when any team trusts this exact issuer. */
export async function issuerTrustedByAnyTeam(issuer: string): Promise<boolean> {
  const { count, error } = await createAdminClient()
    .from("team_idjag_issuers")
    .select("id", { count: "exact", head: true })
    .eq("issuer", issuer);
  if (error) throw error;
  return (count ?? 0) > 0;
}

type IssuerRow = {
  id: string;
  issuer: string;
  allowed_client_ids: string[];
  added_by: string | null;
  created_at: string;
};

function toIssuer(row: IssuerRow): TeamIdJagIssuer {
  return {
    id: row.id,
    issuer: row.issuer,
    allowedClientIds: row.allowed_client_ids,
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
}

/** The team's role for this user, or null when not a member. */
export async function teamRole(teamId: string, userId: string): Promise<"owner" | "member" | null> {
  const { data, error } = await createAdminClient()
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as "owner" | "member" | undefined) ?? null;
}

export async function listTeamIssuers(teamId: string): Promise<TeamIdJagIssuer[]> {
  const { data, error } = await createAdminClient()
    .from("team_idjag_issuers")
    .select("id, issuer, allowed_client_ids, added_by, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toIssuer);
}

export type AddIssuerResult =
  { status: "ok"; issuer: TeamIdJagIssuer } | { status: "not_owner" | "exists" | "limit" };

export async function addTeamIssuer(input: {
  teamId: string;
  userId: string;
  issuer: string;
  clientIds: string[];
}): Promise<AddIssuerResult> {
  const { data, error } = await createAdminClient().rpc("add_team_idjag_issuer", {
    p_team_id: input.teamId,
    p_user_id: input.userId,
    p_issuer: input.issuer,
    p_client_ids: input.clientIds,
    p_max: MAX_TEAM_ISSUERS,
  });
  if (error) throw error;
  const result = data as { status: string; id?: string; created_at?: string };
  if (result.status === "ok") {
    return {
      status: "ok",
      issuer: {
        id: result.id!,
        issuer: input.issuer,
        allowedClientIds: input.clientIds,
        addedBy: input.userId,
        createdAt: result.created_at!,
      },
    };
  }
  if (result.status === "not_owner" || result.status === "exists" || result.status === "limit") {
    return { status: result.status };
  }
  throw new Error(`Unexpected add_team_idjag_issuer status: ${result.status}`);
}

export type RemoveIssuerResult =
  { status: "ok"; issuer: string; revoked: string[] } | { status: "not_owner" | "not_found" };

export async function removeTeamIssuer(input: {
  teamId: string;
  userId: string;
  issuerId: string;
}): Promise<RemoveIssuerResult> {
  const { data, error } = await createAdminClient().rpc("remove_team_idjag_issuer", {
    p_team_id: input.teamId,
    p_user_id: input.userId,
    p_issuer_id: input.issuerId,
  });
  if (error) throw error;
  const result = data as { status: string; issuer?: string; revoked?: string[] };
  if (result.status === "ok") {
    return { status: "ok", issuer: result.issuer!, revoked: result.revoked ?? [] };
  }
  if (result.status === "not_owner" || result.status === "not_found") {
    return { status: result.status };
  }
  throw new Error(`Unexpected remove_team_idjag_issuer status: ${result.status}`);
}
