import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { SUSPENDED, sharingSuspended } from "@/lib/tunnels/accounts";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { gatesOnEdge } from "@/lib/tunnels/edge";
import { passwordProblem } from "@/lib/tunnels/password-hash";
import { setNamePassword } from "@/lib/tunnels/passwords";
import { tunnelPlanOf } from "@/lib/tunnels/plan";

const LIMIT = 30;
const WINDOW_MS = 10 * 60_000;

async function change(
  request: Request,
  params: Promise<{ name: string }>,
  password: string | null | undefined
): Promise<Response> {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { name: raw } = await params;
  const name = raw.toLowerCase();

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `tunnel-names-password:${auth.userId}`,
    LIMIT,
    WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;
  const action = password ? "tunnel.name_password_set" : "tunnel.name_password_cleared";
  const refuse = async (error: string, status: number) => {
    await auditUserAction(request, auth.userId, {
      action,
      status,
      reason: error,
      targetId: name.slice(0, 40),
    });
    return applyRateLimitHeaders(Response.json({ error }, { status }), rateLimit);
  };
  if (await sharingSuspended(auth.userId)) return refuse(SUSPENDED, 403);

  if (password === undefined) return refuse("password is required", 400);
  try {
    const plan = await tunnelPlanOf(auth.userId);
    if (!plan) return Response.json({ error: "Account not found" }, { status: 404 });
    if (password !== null) {
      if (!plan.limits.sharePasswords)
        return refuse("Passwords on links come with Pro and Business.", 403);
      const problem = passwordProblem(password);
      if (problem) return refuse(problem, 400);
    }
    const changed = await setNamePassword(auth.userId, plan.teamIds, name, password);
    if (changed === false) return refuse("Name not found", 404);
    // A live preview under the name follows at once; the 30-second sync
    // catches it if the edge did not answer.
    if (changed) await gatesOnEdge([changed]);
    await auditUserAction(request, auth.userId, {
      action,
      status: 200,
      targetId: name,
    });
    return applyRateLimitHeaders(
      Response.json({ ok: true, password: password !== null }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to change a tunnel name's password", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Puts a kept name behind a password: `{password}`. Every preview under it follows. */
export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  let password: string | undefined;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    password = typeof body.password === "string" && body.password ? body.password : undefined;
  } catch {
    password = undefined;
  }
  return change(request, params, password);
}

/** Takes the password off a kept name. */
export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  return change(request, params, null);
}
