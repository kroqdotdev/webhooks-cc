import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database";
import {
  createApiKeyForUser,
  MAX_KEY_TTL_DAYS,
  parseKeyName,
  type CreatedApiKey,
} from "@/lib/supabase/api-keys";
import {
  assertCanManageDomains,
  deleteDomain,
  DomainError,
  listDomains,
  type DomainAccount,
} from "@/lib/supabase/inbound-domains";
import { parseDisplayName, updateDisplayName } from "@/lib/supabase/profile";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import { createRequestShare } from "@/lib/supabase/request-shares";
import { SHARE_EXPIRY_DAYS, type ShareExpiryDays } from "@/lib/request-share";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { isUuid } from "@/lib/uuid";

/**
 * What an approval can ask for. Each action checks its parameters when the
 * approval is asked for (with the account it is for), describes itself in one
 * sentence and a few facts for the page, and runs:
 *
 * - "collect": when the asker collects it, so a secret it makes (a new API
 *   key) goes straight to the asker and is never stored; `undo` takes it back
 *   when the owner withdrew while it ran.
 * - "approve": the moment the person approves, with its result (never a
 *   secret) kept for the asker to read. Nothing to withdraw afterwards, so
 *   an action that cannot be undone (removing a domain) runs this way.
 */
export type ApprovalAction =
  "api_keys.create" | "request_shares.create" | "domains.remove" | "account.rename";

export interface ActionDetail {
  label: string;
  value: string;
}

/** A refusal the person or the asker should read, with its HTTP status. */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ActionError";
  }
}

type Parsed<P> = { ok: true; params: P } | { ok: false; error: string; status?: number };

interface ActionSpec<P> {
  runAt: "collect" | "approve";
  /** Checks the request for the account it is for (`userId`, its owner). */
  parse(input: unknown, userId: string): Promise<Parsed<P>>;
  summary(params: P): string;
  details(params: P): ActionDetail[];
  /** What the asker gets (may hold a secret on "collect") and what the row keeps (never one). */
  run(userId: string, params: P): Promise<{ result: Record<string, unknown>; stored: Json }>;
  /** Takes back what `run` did, when the owner withdrew while it ran ("collect" only). */
  undo?(userId: string, stored: Json): Promise<void>;
}

// ---------------------------------------------------------------------------
// A new API key
// ---------------------------------------------------------------------------

/** An agent's key lives 90 days unless it asks for another lifetime (at most a year). */
export const DEFAULT_APPROVED_KEY_DAYS = 90;

interface KeyParams {
  name: string;
  expiresInDays: number;
}

const createApiKey: ActionSpec<KeyParams> = {
  runAt: "collect",
  async parse(input) {
    const body = (input ?? {}) as Record<string, unknown>;
    const name = parseKeyName(body.name);
    if (!name.ok) return name;
    const days = body.expiresInDays ?? DEFAULT_APPROVED_KEY_DAYS;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_KEY_TTL_DAYS) {
      return {
        ok: false,
        error: `expiresInDays must be a whole number of days from 1 to ${MAX_KEY_TTL_DAYS}`,
      };
    }
    return { ok: true, params: { name: name.name, expiresInDays: days as number } };
  },
  summary: ({ name, expiresInDays }) =>
    `Create an API key named "${name}" with full access to your account for ${days(expiresInDays)}.`,
  details: ({ name, expiresInDays }) => [
    { label: "Key name", value: name },
    { label: "Works for", value: days(expiresInDays) },
    { label: "Access", value: "Everything an API key can do on your account" },
  ],
  async run(userId, { name, expiresInDays }) {
    const created: CreatedApiKey = await createApiKeyForUser(userId, name, expiresInDays);
    return {
      result: { ...created },
      stored: { keyPrefix: created.keyPrefix, expiresAt: created.expiresAt, name: created.name },
    };
  },
  async undo(userId, stored) {
    const prefix = (stored as { keyPrefix?: string } | null)?.keyPrefix;
    if (!prefix) return;
    const { error } = await createAdminClient()
      .from("api_keys")
      .delete()
      .eq("user_id", userId)
      .eq("key_prefix", prefix)
      .is("agent_registration_id", null);
    if (error) throw error;
  },
};

// ---------------------------------------------------------------------------
// A share link: a public, read-only copy of one request
// ---------------------------------------------------------------------------

interface ShareParams {
  requestId: string;
  expiresInDays: ShareExpiryDays;
  hideSensitive: boolean;
  /** For the page: what is being published. */
  method: string;
  path: string;
}

const SHARE_REFUSALS = {
  not_found: { status: 404, message: "Request not found" },
  email: { status: 400, message: "Emails cannot be shared" },
  not_owner: { status: 403, message: "Only the endpoint's owner can share its requests" },
  limit: {
    status: 409,
    message: "The account has as many live share links as it may. Revoke some first.",
  },
} as const;

const createShareLink: ActionSpec<ShareParams> = {
  runAt: "approve",
  async parse(input, userId) {
    const body = (input ?? {}) as Record<string, unknown>;
    const requestId = body.requestId;
    if (typeof requestId !== "string" || !isUuid(requestId)) {
      return { ok: false, error: "Request not found", status: 404 };
    }
    const expiresInDays = (body.expiresInDays ?? 7) as ShareExpiryDays;
    if (!SHARE_EXPIRY_DAYS.includes(expiresInDays)) {
      return {
        ok: false,
        error: `expiresInDays must be one of ${SHARE_EXPIRY_DAYS.join(", ")}`,
      };
    }
    const request = await getRequestByIdForUser(userId, requestId);
    if (!request) return { ok: false, error: "Request not found", status: 404 };
    if (request.kind === "email") return { ok: false, error: "Emails cannot be shared" };
    return {
      ok: true,
      params: {
        requestId,
        expiresInDays,
        hideSensitive: body.hideSensitive !== false,
        method: request.method,
        path: request.path.slice(0, 200),
      },
    };
  },
  summary: ({ method, path, expiresInDays }) =>
    `Publish a read-only copy of the request ${method} ${path} at a public link for ${days(expiresInDays)}.`,
  details: ({ method, path, expiresInDays, hideSensitive }) => [
    { label: "Request", value: `${method} ${path}` },
    { label: "Link works for", value: days(expiresInDays) },
    {
      label: "Headers left out",
      value: hideSensitive
        ? "Credentials, signatures and tokens"
        : "Credentials only (signatures and tokens are shown)",
    },
    { label: "Who can see it", value: "Anyone who has the link" },
  ],
  async run(userId, params) {
    const created = await createRequestShare({
      userId,
      requestId: params.requestId,
      expiresInDays: params.expiresInDays,
      hideSensitive: params.hideSensitive,
    });
    if (!created.ok) {
      const refusal = SHARE_REFUSALS[created.error];
      throw new ActionError(refusal.status, refusal.message);
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";
    const result = {
      id: created.share.id,
      url: `${appUrl}/s/${created.share.token}`,
      expiresAt: new Date(created.share.expiresAt).toISOString(),
      redactedHeaders: created.share.redactedHeaders,
    };
    // The link is no secret from its owner (listing share links shows it),
    // so the asker reads it from the row.
    return { result, stored: result };
  },
};

// ---------------------------------------------------------------------------
// Removing an inbound domain
// ---------------------------------------------------------------------------

interface DomainParams {
  domainId: string;
  teamId: string | null;
  domain: string;
}

function domainAccount(userId: string, teamId: string | null): DomainAccount {
  return teamId ? { kind: "team", teamId } : { kind: "user", userId };
}

async function canManage(account: DomainAccount, userId: string): Promise<void> {
  try {
    await assertCanManageDomains(account, userId);
  } catch (error) {
    if (error instanceof TeamBillingError) {
      throw new ActionError(error.code === "team_not_found" ? 404 : 403, error.message);
    }
    if (error instanceof DomainError) throw new ActionError(error.status, error.message);
    throw error;
  }
}

const removeDomain: ActionSpec<DomainParams> = {
  runAt: "approve",
  async parse(input, userId) {
    const body = (input ?? {}) as Record<string, unknown>;
    const domainId = body.domainId;
    const teamId = body.teamId ?? null;
    if (typeof domainId !== "string" || !isUuid(domainId)) {
      return { ok: false, error: "Domain not found", status: 404 };
    }
    if (teamId !== null && (typeof teamId !== "string" || !isUuid(teamId))) {
      return { ok: false, error: "Team not found", status: 404 };
    }
    const account = domainAccount(userId, teamId as string | null);
    try {
      await canManage(account, userId);
    } catch (error) {
      if (error instanceof ActionError) {
        return { ok: false, error: error.message, status: error.status };
      }
      throw error;
    }
    const found = (await listDomains(account)).find((d) => d.id === domainId);
    if (!found) return { ok: false, error: "Domain not found", status: 404 };
    return {
      ok: true,
      params: { domainId, teamId: teamId as string | null, domain: found.domain },
    };
  },
  summary: ({ domain }) =>
    `Remove the inbound domain ${domain}: mail to it is refused from then on.`,
  details: ({ domain, teamId }) => [
    { label: "Domain", value: domain },
    { label: "Belongs to", value: teamId ? "A team you own" : "Your account" },
    { label: "Mail to it", value: "Refused once it is removed" },
  ],
  async run(userId, { domainId, teamId, domain }) {
    const account = domainAccount(userId, teamId);
    await canManage(account, userId);
    try {
      await deleteDomain(account, domainId);
    } catch (error) {
      if (error instanceof DomainError) throw new ActionError(error.status, error.message);
      throw error;
    }
    const result = { removed: domain, domainId };
    return { result, stored: result };
  },
};

// ---------------------------------------------------------------------------
// Renaming the account (its display name)
// ---------------------------------------------------------------------------

interface RenameParams {
  name: string | null;
}

const renameAccount: ActionSpec<RenameParams> = {
  runAt: "approve",
  async parse(input) {
    const body = (input ?? {}) as Record<string, unknown>;
    const parsed = parseDisplayName(body.name);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, params: { name: parsed.value } };
  },
  summary: ({ name }) =>
    name === null
      ? "Clear the account's display name."
      : `Change the account's display name to "${name}".`,
  details: ({ name }) => [{ label: "New display name", value: name ?? "None" }],
  async run(userId, { name }) {
    const saved = await updateDisplayName(userId, name);
    const result = { name: saved };
    return { result, stored: result };
  },
};

function days(count: number): string {
  if (count === 1) return "1 day";
  if (count % 365 === 0) return count === 365 ? "1 year" : `${count / 365} years`;
  return `${count} days`;
}

const ACTIONS: Record<ApprovalAction, ActionSpec<unknown>> = {
  "api_keys.create": createApiKey as ActionSpec<unknown>,
  "request_shares.create": createShareLink as ActionSpec<unknown>,
  "domains.remove": removeDomain as ActionSpec<unknown>,
  "account.rename": renameAccount as ActionSpec<unknown>,
};

export function actionSpec(action: ApprovalAction): ActionSpec<unknown> {
  return ACTIONS[action];
}
