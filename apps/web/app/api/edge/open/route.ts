import { auditUserAction } from "@/lib/audit";
import { getWebhookUrl } from "@/lib/constants";
import { resolveEndpointAccess } from "@/lib/supabase/teams-endpoints";
import { accountForKey } from "@/lib/tunnels/accounts";
import { previewUrlFor, tunnelConfig } from "@/lib/tunnels/config";
import { fromEdge, notEdge } from "@/lib/tunnels/edge-auth";
import {
  nameForShare,
  randomName,
  randomNameFree,
  undoShareReservation,
} from "@/lib/tunnels/names";
import { hashPassword, passwordProblem, runPasswordVersion } from "@/lib/tunnels/password-hash";
import { gateOf } from "@/lib/tunnels/passwords";
import { tunnelPlanOf, type TunnelPlan } from "@/lib/tunnels/plan";
import { openShare, runName, someoneElseSharing, stoppedRun } from "@/lib/tunnels/shares";
import { tellFor } from "@/lib/tunnels/stops";
import { overMessage, usageOf } from "@/lib/tunnels/usage";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

/**
 * The edge asks whether a CLI run may open: the key, the name it asked for,
 * what it runs on, its run id, where it connected from, a password if
 * `--password` gave one, and for `whk tunnel --live` the kind and the
 * endpoint's slug. The answer is the run's id, its name and address, when it
 * must close (Free previews last two hours), whether visitors see the notice
 * first, and the version of the password visitors need, if any.
 */
/**
 * Who opens a share through the edge: always `whk` (the SDKs and MCP server
 * run it too), so the audit row names the CLI rather than the edge.
 */
const EDGE_CLIENT_AGENT = "whk-cli/edge";

const openBody = z.object({
  apiKey: z.unknown().optional(),
  name: z.unknown().optional(),
  client: z.unknown().optional(),
  instance: z.unknown().optional(),
  address: z.unknown().optional(),
  password: z.unknown().optional(),
  kind: z.unknown().optional(),
  endpoint: z.unknown().optional(),
});

export async function POST(request: Request) {
  if (!fromEdge(request)) return notEdge();
  const config = tunnelConfig();
  if (!config) return notEdge();
  // A body that cannot be read counts as an empty one.
  const parsed = await parseJsonBodyWith(request, openBody);
  const body: z.infer<typeof openBody> = "data" in parsed ? parsed.data : {};

  const account = await accountForKey(body.apiKey);
  if ("error" in account)
    return Response.json({ error: account.error }, { status: account.status });
  const { userId } = account;

  const instance =
    typeof body.instance === "string" && body.instance ? body.instance.slice(0, 64) : null;
  // A reconnect of a run that was stopped while its CLI was not listening.
  const stopped = instance ? await stoppedRun(userId, instance) : null;
  if (stopped)
    return Response.json(
      { error: `This share was stopped: ${tellFor(stopped)}. Start a new one.` },
      { status: 410 }
    );

  const plan = await tunnelPlanOf(userId);
  if (!plan) return Response.json({ error: "That account is gone." }, { status: 401 });

  const common = {
    userId,
    plan,
    client: cleanClient(body.client),
    keyId: account.keyId,
    agentRegistrationId: account.agentRegistrationId,
    instance,
    clientAddress: typeof body.address === "string" ? body.address.slice(0, 64) : null,
  };

  if (body.kind === "live") return openLive(common, body.endpoint);
  if (body.kind !== undefined && body.kind !== "share")
    return Response.json({ error: "Unknown kind." }, { status: 400 });

  // Past the plan's data for the month, previews are paused.
  const month = await usageOf(plan, userId);
  if (month.over) return Response.json({ error: overMessage(month) }, { status: 403 });

  const password = typeof body.password === "string" && body.password ? body.password : null;
  if (password && !plan.limits.sharePasswords)
    return Response.json(
      { error: "Passwords on links come with Pro and Business." },
      { status: 403 }
    );
  if (password) {
    const problem = passwordProblem(password);
    if (problem) return Response.json({ error: `Password: ${problem}` }, { status: 400 });
  }

  const requested = typeof body.name === "string" && body.name ? body.name : null;
  // A run reconnecting keeps its random name, so the link that was sent
  // still works: only a name we drew, and only while it is still free.
  const free = plan.key === "free";
  const again = !requested && instance ? await runName(userId, instance) : null;
  const kept = again && (await randomNameFree(userId, again, free)) ? again : null;
  const named = kept
    ? { name: kept, reserved: false }
    : await nameForShare(userId, plan, requested);
  if ("error" in named) return Response.json({ error: named.error }, { status: named.status });
  // A name `whk share --name` reserved just now is kept only if the share
  // opens: a refused share must not use up one of the plan's names.
  const refuse = async (error: string, status: number) => {
    if (named.reserved) await undoShareReservation(userId, named.name);
    return Response.json({ error }, { status });
  };

  // One preview runs under a name at a time: a teammate's is theirs until stopped.
  const other = requested ? await someoneElseSharing(named.name, userId) : null;
  if (other)
    return refuse(
      `${other} is sharing under ${named.name} right now. Stop that share first, or use another name.`,
      409
    );

  const open = async (name: string) => {
    const runPassword = password
      ? {
          hash: await hashPassword(password),
          version: runPasswordVersion(config.edgeSecret, userId, name, instance),
        }
      : null;
    const result = await openShare({
      ...common,
      kind: "share",
      name,
      endpointId: null,
      password: runPassword,
    });
    return { result, name, runPassword };
  };
  let opened = await open(named.name);
  // A random name drawn by two runs at once: draw again.
  if ("taken" in opened.result && !requested) opened = await open(await randomName(free));
  const { result, name, runPassword } = opened;
  if ("error" in result) return refuse(result.error, result.status);

  // `whk share --name` kept a new name like the reserve route does: audit it
  // the same way, as the user's key and the CLI (this request is the edge's).
  if (named.reserved)
    await auditUserAction(request, userId, {
      action: "tunnel.name_reserved",
      status: 201,
      targetId: named.name,
      metadata: { source: "share" },
      via: account.agentRegistrationId ? "agent_token" : "api_key",
      userAgent: EDGE_CLIENT_AGENT,
    });

  const gate = await gateOf({
    id: result.shareId,
    name,
    user_id: userId,
    password_hash: runPassword?.hash ?? null,
    password_version: runPassword?.version ?? null,
  });
  return Response.json({
    shareId: result.shareId,
    userId,
    name,
    url: previewUrlFor(config.previewOrigin, name),
    ...expiry(result.expiresAt),
    plan: plan.key,
    notice: plan.notice,
    gate: gate?.version ?? null,
  });
}

function expiry(expiresAt: Date | null) {
  return {
    expiresAt: expiresAt?.toISOString() ?? null,
    expiresIn: expiresAt
      ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000))
      : null,
  };
}

/** "mads-laptop, macOS" as the CLI says it, cut down to something safe to show. */
function cleanClient(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[^\p{L}\p{N} ._,()@+-]/gu, "")
    .trim()
    .slice(0, 100);
}

/**
 * `whk tunnel --live`: the endpoint must be the account's own or shared with
 * one of its teams that has a live subscription. Live sessions are not previews: no name, no notice, no
 * password, and their traffic counts as captures, not data.
 */
async function openLive(
  common: {
    userId: string;
    plan: TunnelPlan;
    client: string;
    keyId: string | null;
    agentRegistrationId: string | null;
    instance: string | null;
    clientAddress: string | null;
  },
  endpoint: unknown
): Promise<Response> {
  if (typeof endpoint !== "string" || !/^[a-zA-Z0-9_-]{1,50}$/.test(endpoint))
    return Response.json({ error: "Name the endpoint to relay." }, { status: 400 });
  // The same rule as every other endpoint read: the owner, or a member of a
  // team with a live subscription the endpoint is shared with
  // (resolveEndpointAccess, can_view_team_endpoint()). A lapsed team's
  // members lose its shared endpoints here too.
  const slug = endpoint.toLowerCase();
  const access = await resolveEndpointAccess(common.userId, slug);
  if (!access)
    return Response.json({ error: "No endpoint with that slug in your account." }, { status: 404 });
  const row = { id: access.endpointId, slug };

  const result = await openShare({
    ...common,
    kind: "live",
    name: null,
    endpointId: row.id,
    password: null,
  });
  if ("error" in result) {
    const status = "taken" in result ? 409 : result.status;
    const message =
      "taken" in result ? "Someone else is relaying this endpoint right now." : result.error;
    return Response.json({ error: message }, { status });
  }
  return Response.json({
    shareId: result.shareId,
    userId: common.userId,
    name: row.slug,
    url: getWebhookUrl(row.slug),
    expiresAt: null,
    expiresIn: null,
    plan: common.plan.key,
    notice: false,
    gate: null,
    endpointId: row.id,
  });
}
