import { auditUserAction, type AuditAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import {
  assertCanManageDomains,
  DomainError,
  type DomainAccount,
} from "@/lib/supabase/inbound-domains";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { isUuid } from "@/lib/uuid";

/**
 * The account a domain request is for (?team=<id> for a team, owner only)
 * and who asks, or a response to return. Any key of the account may list,
 * add, verify and route domains (the DNS records are the proof of who holds
 * one, and keys already decide where an endpoint forwards); removing one
 * with a key asks the owner first (domains.remove, lib/approvals). `keyId`
 * is set for an API key or agent token, absent for a session.
 */
export async function domainAccount(request: Request): Promise<
  | {
      account: DomainAccount;
      userId: string;
      keyId?: string;
      agentRegistrationId?: string | null;
    }
  | Response
> {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const teamId = new URL(request.url).searchParams.get("team");
  if (teamId !== null && !isUuid(teamId)) {
    return Response.json({ error: "Team not found" }, { status: 404 });
  }
  const account: DomainAccount = teamId
    ? { kind: "team", teamId }
    : { kind: "user", userId: auth.userId };
  try {
    await assertCanManageDomains(account, auth.userId);
  } catch (error) {
    return domainErrorResponse(error, "Domains failed");
  }
  return {
    account,
    userId: auth.userId,
    keyId: auth.keyId,
    agentRegistrationId: auth.agentRegistrationId,
  };
}

/** The response for an error from lib/supabase/inbound-domains. */
export function domainErrorResponse(error: unknown, what: string): Response {
  if (error instanceof DomainError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof TeamBillingError) {
    const status = error.code === "not_owner" ? 403 : error.code === "team_not_found" ? 404 : 400;
    return Response.json({ error: error.message }, { status });
  }
  reportError(what, error);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

export async function auditDomain(
  request: Request,
  userId: string,
  account: DomainAccount,
  action: AuditAction,
  status: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await auditUserAction(request, userId, {
    action,
    status,
    teamId: account.kind === "team" ? account.teamId : null,
    metadata,
  });
}
