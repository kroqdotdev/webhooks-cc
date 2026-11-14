import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { askForBillingChange } from "@/lib/billing/ask";
import { handleCapacityGet, handleCapacityPost, readCapacityAction } from "@/lib/capacity-route";

/** Extra request capacity for the signed-in user's own account (lib/capacity-route.ts). */
// A read: any key of the account, or a session. A change (POST) from an API
// key or agent token is a quoted approval for the owner (202).
export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  return handleCapacityGet({ kind: "user", userId: auth.userId }, request);
}

export async function POST(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const action = await readCapacityAction(request);
  if (action instanceof Response) return action;
  const asked = await askForBillingChange(request, auth, null, {
    kind: "capacity",
    capacity: action,
  });
  if (asked) return asked;
  return handleCapacityPost(request, { kind: "user", userId: auth.userId }, auth.userId, action);
}
