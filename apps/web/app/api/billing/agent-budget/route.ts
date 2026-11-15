import { authenticateRequestRequireUser } from "@/lib/api-auth";
import {
  readAgentBudgetResponse,
  setAgentBudgetOrAskApproval,
} from "@/lib/billing/agent-budget-route";

/** The account's agent spend budget: read it (any key, or a session). */
export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  return readAgentBudgetResponse(auth, null);
}

/** Sets it: a session sets it, a key lowers it at once or asks the owner to raise it (202). */
export async function PUT(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  return setAgentBudgetOrAskApproval(request, auth, null);
}
