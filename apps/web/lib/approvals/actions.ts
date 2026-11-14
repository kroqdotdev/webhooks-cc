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
import {
  AssistRefusal,
  assistSamples,
  assistsLeft,
  parseAssistInput,
  runEndpointAssist,
  type AssistInput,
} from "@/lib/ai/endpoint-assist";
import { aiOffered } from "@/lib/ai/model";
import {
  accessToken,
  googleConfig,
  GoogleError,
  sheetTitles,
  spreadsheetUrl,
} from "@/lib/integrations/google";
import { googleRefreshToken, listGoogleConnections } from "@/lib/supabase/google-connections";

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
 *   an action that cannot be undone (removing a domain) runs this way. The
 *   page may hand it what the person chose there (`input`: a picked file).
 * - "browser": approving sends the person's browser somewhere to finish it
 *   (Google's consent page), and what comes back there completes it
 *   (completeBrowserApproval), result kept like "approve".
 */
export type ApprovalAction =
  | "api_keys.create"
  | "request_shares.create"
  | "domains.remove"
  | "account.rename"
  | "google.connect"
  | "google.pick"
  | "ai.assist";

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
  runAt: "collect" | "approve" | "browser";
  /** Checks the request for the account it is for (`userId`, its owner). */
  parse(input: unknown, userId: string): Promise<Parsed<P>>;
  summary(params: P): string;
  /** The facts the page lists, read when the page loads (they may look things up). */
  details(params: P, userId: string): ActionDetail[] | Promise<ActionDetail[]>;
  /** What the page itself needs to answer (never shown as a fact): the connection a pick is for. */
  page?(params: P): Record<string, unknown>;
  /**
   * What the asker gets (may hold a secret on "collect") and what the row
   * keeps (never one). `input` is what the person chose on the page.
   */
  run(
    userId: string,
    params: P,
    input?: unknown
  ): Promise<{ result: Record<string, unknown>; stored: Json }>;
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
    // A team member can read the request but not share it: say so now, not
    // after the owner was asked (createRequestShare checks again).
    const { data: endpoint, error } = await createAdminClient()
      .from("endpoints")
      .select("user_id")
      .eq("id", request.endpointId)
      .maybeSingle();
    if (error) throw error;
    if (endpoint?.user_id !== userId) {
      return { ok: false, error: SHARE_REFUSALS.not_owner.message, status: 403 };
    }
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

// ---------------------------------------------------------------------------
// Connecting a Google account (for Sheets destinations)
// ---------------------------------------------------------------------------

const GOOGLE_ACCESS =
  "Spreadsheets webhooks.cc creates, and ones you choose for it; nothing else in your Drive";

const connectGoogle: ActionSpec<Record<string, never>> = {
  runAt: "browser",
  async parse() {
    if (!googleConfig()) {
      return { ok: false, error: "Google Sheets is not set up on this server.", status: 503 };
    }
    return { ok: true, params: {} };
  },
  summary: () => "Connect a Google account for Google Sheets destinations.",
  details: () => [
    { label: "Next", value: "Google asks you to choose the account and allow access" },
    { label: "Access", value: GOOGLE_ACCESS },
  ],
  async run() {
    // Finished by the Google callback (completeBrowserApproval), never here.
    throw new ActionError(400, "This finishes at Google.");
  },
};

// ---------------------------------------------------------------------------
// Choosing an existing spreadsheet from Drive
// ---------------------------------------------------------------------------

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

interface PickParams {
  connectionId: string;
  email: string | null;
}

async function ownConnection(userId: string, connectionId: unknown) {
  if (typeof connectionId !== "string" || !isUuid(connectionId)) return null;
  return (await listGoogleConnections(userId)).find((c) => c.id === connectionId) ?? null;
}

const pickSpreadsheet: ActionSpec<PickParams> = {
  runAt: "approve",
  async parse(input, userId) {
    if (!googleConfig()) {
      return { ok: false, error: "Google Sheets is not set up on this server.", status: 503 };
    }
    const connection = await ownConnection(
      userId,
      ((input ?? {}) as Record<string, unknown>).connectionId
    );
    if (!connection) return { ok: false, error: "Connect a Google account first.", status: 404 };
    return { ok: true, params: { connectionId: connection.id, email: connection.email } };
  },
  summary: ({ email }) =>
    `Choose a spreadsheet in ${email ?? "your Google account"} for Google Sheets destinations.`,
  details: ({ email }) => [
    { label: "Google account", value: email ?? "Google account" },
    { label: "Next", value: "Google's Drive picker opens: choose one spreadsheet" },
    { label: "Access", value: "Only the spreadsheet you choose" },
  ],
  page: ({ connectionId }) => ({ connectionId }),
  async run(userId, { connectionId }, input) {
    const file = ((input ?? {}) as Record<string, unknown>).file;
    if (typeof file !== "string" || !SPREADSHEET_ID.test(file)) {
      throw new ActionError(400, "Choose a spreadsheet in Google's window first.");
    }
    const config = googleConfig();
    if (!config) throw new ActionError(503, "Google Sheets is not set up on this server.");
    const refreshToken = await googleRefreshToken(userId, connectionId);
    if (!refreshToken) throw new ActionError(404, "Connect a Google account first.");
    let tabs: string[];
    try {
      tabs = await sheetTitles(await accessToken(config, refreshToken), file);
    } catch (error) {
      if (error instanceof GoogleError) {
        throw new ActionError(
          error.reconnect ? 409 : 400,
          error.reconnect
            ? "Google no longer accepts this connection. Connect it again."
            : error.message
        );
      }
      // Reading the tabs changes nothing, so any failure gives the approval
      // back to try again rather than ending it without a result.
      throw new ActionError(503, "Google could not be reached. Try again in a moment.");
    }
    const result = { connectionId, spreadsheetId: file, url: spreadsheetUrl(file), tabs };
    return { result, stored: result };
  },
};

// ---------------------------------------------------------------------------
// AI setup: sending picked emails to the model
// ---------------------------------------------------------------------------

interface AssistParams extends AssistInput {
  slug: string;
}

function askLabel(ask: AssistInput["ask"]): string {
  if (ask.kind === "field") return `Find a field "${ask.name}": ${ask.description}`;
  if (ask.kind === "repair") return `Repair the field "${ask.field.name}"`;
  return ask.description ? `Suggest a layout: ${ask.description}` : "Suggest a layout";
}

const aiAssist: ActionSpec<AssistParams> = {
  runAt: "approve",
  async parse(input, userId) {
    if (!aiOffered()) {
      return { ok: false, error: "AI setup is not available on this server.", status: 404 };
    }
    const body = (input ?? {}) as Record<string, unknown>;
    if (typeof body.slug !== "string")
      return { ok: false, error: "Endpoint not found", status: 404 };
    const parsed = parseAssistInput(body);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    try {
      const { endpointId } = await assistSamples(userId, body.slug, parsed.requestIds);
      const left = await assistsLeft(endpointId);
      if (left.used >= left.allowed) {
        return {
          ok: false,
          error: `No AI assists left: your plan has ${left.allowed} in 30 days.`,
          status: 429,
        };
      }
    } catch (error) {
      if (error instanceof AssistRefusal) {
        return { ok: false, error: error.message, status: error.status };
      }
      throw error;
    }
    return { ok: true, params: { slug: body.slug, ...parsed } };
  },
  summary: ({ requestIds, slug }) =>
    `Send ${requestIds.length === 1 ? "1 email" : `${requestIds.length} emails`} of the endpoint ${slug} to Anthropic's AI to suggest fields. Nothing is saved until they are applied.`,
  async details({ slug, ask, requestIds }, userId) {
    const facts: ActionDetail[] = [{ label: "Asks", value: askLabel(ask).slice(0, 200) }];
    try {
      const { requests } = await assistSamples(userId, slug, requestIds);
      requests.forEach((request, i) => {
        const email = request.email;
        const subject = email?.subject?.trim() || "(no subject)";
        const from = email?.from?.[0]?.address ?? "unknown sender";
        facts.push({ label: `Email ${i + 1}`, value: `${subject.slice(0, 120)}, from ${from}` });
      });
    } catch {
      facts.push({ label: "Emails", value: "Some are no longer kept; approving will fail" });
    }
    facts.push(
      { label: "Sent to", value: "Anthropic (subject, sender, recipients, text, headers)" },
      { label: "Never sent", value: "Attachments" },
      { label: "Uses", value: "One AI assist" }
    );
    return facts;
  },
  async run(userId, { slug, ask, requestIds }) {
    try {
      const result = await runEndpointAssist(userId, slug, { ask, requestIds });
      return { result: { ...result }, stored: result as unknown as Json };
    } catch (error) {
      if (error instanceof AssistRefusal) throw new ActionError(error.status, error.message);
      throw error;
    }
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
  "google.connect": connectGoogle as ActionSpec<unknown>,
  "google.pick": pickSpreadsheet as ActionSpec<unknown>,
  "ai.assist": aiAssist as ActionSpec<unknown>,
};

export function actionSpec(action: ApprovalAction): ActionSpec<unknown> {
  return ACTIONS[action];
}
