import { auditUserAction } from "@/lib/audit";
import { BLOCK_REQUESTS, parseBlockCount } from "@/lib/capacity";
import { loggablePolarError, PolarConfigError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import {
  assertCanManage,
  CapacityError,
  changeMonthlyBlocks,
  createOneTimeBlocksCheckout,
  getCapacityState,
  setOverage,
  type CapacityAccount,
} from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";

/**
 * The request the extra-capacity routes take (POST):
 *
 *   { action: "buy_blocks", blocks }          one-time blocks, answers { url }
 *   { action: "set_monthly_blocks", blocks }  0 ends them; more answers { url }
 *   { action: "set_overage", enabled, maxBlocks? }
 *
 * Every answer without a checkout carries the new { state }.
 */
export type CapacityAction =
  | { action: "buy_blocks"; blocks: number }
  | { action: "set_monthly_blocks"; blocks: number }
  | { action: "set_overage"; enabled: boolean; maxBlocks?: number };

export function parseCapacityAction(body: unknown): CapacityAction | null {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  switch (input.action) {
    case "buy_blocks": {
      const blocks = parseBlockCount(input.blocks);
      return blocks === null ? null : { action: "buy_blocks", blocks };
    }
    case "set_monthly_blocks": {
      const blocks = parseBlockCount(input.blocks, { allowZero: true });
      return blocks === null ? null : { action: "set_monthly_blocks", blocks };
    }
    case "set_overage": {
      if (typeof input.enabled !== "boolean") return null;
      if (input.maxBlocks === undefined) return { action: "set_overage", enabled: input.enabled };
      const maxBlocks = parseBlockCount(input.maxBlocks);
      return maxBlocks === null
        ? null
        : { action: "set_overage", enabled: input.enabled, maxBlocks };
    }
    default:
      return null;
  }
}

function errorResponse(error: unknown, label: string): Response {
  if (error instanceof CapacityError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof TeamBillingError) {
    const status = error.code === "not_owner" ? 403 : error.code === "team_not_found" ? 404 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof PolarConfigError) {
    reportError(`${label} misconfigured`, error);
    return Response.json({ error: "Billing is not configured" }, { status: 500 });
  }
  reportError(`${label} failed`, loggablePolarError(error));
  return Response.json({ error: "Could not update extra requests" }, { status: 500 });
}

/** GET: the account's extra capacity. Teams: any member may look. */
export async function handleCapacityGet(account: CapacityAccount): Promise<Response> {
  try {
    return Response.json(await getCapacityState(account));
  } catch (error) {
    return errorResponse(error, "Capacity state");
  }
}

/** POST: changes extra capacity. Teams: the owner only. Audited either way. */
export async function handleCapacityPost(
  request: Request,
  account: CapacityAccount,
  userId: string
): Promise<Response> {
  const teamId = account.kind === "team" ? account.teamId : undefined;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const action = parseCapacityAction(body);
  if (!action) {
    return Response.json(
      { error: "Unknown action, or a block count outside 1 to 400" },
      { status: 400 }
    );
  }

  const auditAction = `billing.capacity.${action.action}` as const;
  const metadata: Record<string, unknown> = { ...action };
  delete metadata.action;

  try {
    await assertCanManage(account, userId);

    let url: string | null = null;
    if (action.action === "buy_blocks") {
      url = await createOneTimeBlocksCheckout(account, userId, action.blocks);
    } else if (action.action === "set_monthly_blocks") {
      const result = await changeMonthlyBlocks(account, userId, action.blocks);
      if (result.kind === "checkout") url = result.url;
    } else {
      const result = await setOverage(account, userId, {
        enabled: action.enabled,
        maxRequests: action.maxBlocks === undefined ? undefined : action.maxBlocks * BLOCK_REQUESTS,
      });
      if (result.kind === "checkout") url = result.url;
    }

    await auditUserAction(request, userId, {
      action: auditAction,
      status: 200,
      teamId,
      metadata: { ...metadata, checkout: url !== null },
    });
    if (url) return Response.json({ url });
    return Response.json({ state: await getCapacityState(account) });
  } catch (error) {
    const response = errorResponse(error, "Capacity change");
    await auditUserAction(request, userId, {
      action: auditAction,
      status: response.status,
      // Only our own messages: a Polar error's message embeds the response body.
      reason:
        error instanceof CapacityError || error instanceof TeamBillingError
          ? error.message
          : undefined,
      teamId,
      metadata,
    });
    return response;
  }
}
