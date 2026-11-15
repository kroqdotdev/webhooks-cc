import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  readAgentBudgetResponse,
  setAgentBudgetOrAskApproval,
} from "@/lib/billing/agent-budget-route";

/** A team's agent spend budget: its owner reads it (any of their keys, or a session). */
export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { teamId } = await params;
  return readAgentBudgetResponse(auth, teamId);
}

/** Only the team's owner sets it: a session sets it, a key lowers it or asks to raise it (202). */
export async function PUT(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { teamId } = await params;
  return setAgentBudgetOrAskApproval(request, auth, teamId);
}
