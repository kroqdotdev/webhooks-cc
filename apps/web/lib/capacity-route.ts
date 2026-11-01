import { auditUserAction } from "@/lib/audit";
import {
  BLOCK_PAGES,
  BLOCK_REQUESTS,
  MAX_BLOCKS,
  MAX_PAGE_BLOCKS,
  parseBlockCount,
} from "@/lib/capacity";
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
  type CapacityResource,
} from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";

/**
 * The request the extra-capacity routes take (POST):
 *
 *   { action: "buy_blocks", blocks }          one-time blocks, answers { url }
 *   { action: "set_monthly_blocks", blocks }  0 ends them; more answers { url }
 *   { action: "set_overage", enabled, maxBlocks? }
 *
 * with `resource: "pages"` for parsed pages (Business), "requests" when left
 * out. Every answer without a checkout carries the new { state }.
 */
export type CapacityAction = { resource?: CapacityResource } & (
  | { action: "buy_blocks"; blocks: number }
  | { action: "set_monthly_blocks"; blocks: number }
  | { action: "set_overage"; enabled: boolean; maxBlocks?: number }
);

/** The resource a request names, or null when it names something else. */
export function parseResource(value: unknown): CapacityResource | null {
  if (value === undefined || value === null || value === "requests") return "requests";
  return value === "pages" ? "pages" : null;
}

export function parseCapacityAction(body: unknown): CapacityAction | null {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  const resource = parseResource(input.resource);
  if (!resource) return null;
  const max = resource === "pages" ? MAX_PAGE_BLOCKS : MAX_BLOCKS;
  switch (input.action) {
    case "buy_blocks": {
      const blocks = parseBlockCount(input.blocks, { max });
      return blocks === null ? null : { resource, action: "buy_blocks", blocks };
    }
    case "set_monthly_blocks": {
      const blocks = parseBlockCount(input.blocks, { allowZero: true, max });
      return blocks === null ? null : { resource, action: "set_monthly_blocks", blocks };
    }
    case "set_overage": {
      if (typeof input.enabled !== "boolean") return null;
      if (input.maxBlocks === undefined) {
        return { resource, action: "set_overage", enabled: input.enabled };
      }
      const maxBlocks = parseBlockCount(input.maxBlocks, { max });
      return maxBlocks === null
        ? null
        : { resource, action: "set_overage", enabled: input.enabled, maxBlocks };
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

/** GET: the account's extra capacity (`?resource=pages` for parsed pages). Teams: any member may look. */
export async function handleCapacityGet(
  account: CapacityAccount,
  request?: Request
): Promise<Response> {
  const resource = parseResource(
    request ? new URL(request.url).searchParams.get("resource") : undefined
  );
  if (!resource) return Response.json({ error: "Unknown resource" }, { status: 400 });
  try {
    return Response.json(await getCapacityState(account, resource));
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
      { error: "Unknown action or resource, or a block count outside what it allows" },
      { status: 400 }
    );
  }

  const auditAction = `billing.capacity.${action.action}` as const;
  const metadata: Record<string, unknown> = { ...action };
  delete metadata.action;
  const resource = action.resource ?? "requests";
  const blockSize = resource === "pages" ? BLOCK_PAGES : BLOCK_REQUESTS;

  try {
    await assertCanManage(account, userId);

    let url: string | null = null;
    if (action.action === "buy_blocks") {
      url = await createOneTimeBlocksCheckout(account, userId, action.blocks, resource);
    } else if (action.action === "set_monthly_blocks") {
      const result = await changeMonthlyBlocks(account, userId, action.blocks, resource);
      if (result.kind === "checkout") url = result.url;
    } else {
      const result = await setOverage(
        account,
        userId,
        {
          enabled: action.enabled,
          maxRequests: action.maxBlocks === undefined ? undefined : action.maxBlocks * blockSize,
        },
        resource
      );
      if (result.kind === "checkout") url = result.url;
    }

    await auditUserAction(request, userId, {
      action: auditAction,
      status: 200,
      teamId,
      metadata: { ...metadata, checkout: url !== null },
    });
    if (url) return Response.json({ url });
    return Response.json({ state: await getCapacityState(account, resource) });
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
