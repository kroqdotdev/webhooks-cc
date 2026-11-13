import { deviceApprover } from "@/lib/device-session";
import { networkOf } from "@/lib/device-requester";
import { ApprovalError, reviewApproval } from "@/lib/approvals/store";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/approvals/review?code=XXXX-XXXX: what the approval page shows
 * about a pending approval. A browser session of the account it is for,
 * past its two-factor sign-in when it has one.
 */
export async function GET(request: Request) {
  const rateLimited = await checkRateLimit(request, "approval-review", 30);
  if (rateLimited) return rateLimited;

  const code = new URL(request.url).searchParams.get("code");
  if (!code || code.length > 16) {
    return Response.json({ error: "Missing code parameter" }, { status: 400 });
  }

  try {
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;
    const review = await reviewApproval(code, approver.userId, networkOf(request));
    if (!review) {
      return Response.json(
        { error: "This code has expired or was already answered." },
        { status: 404 }
      );
    }
    return Response.json(review);
  } catch (err) {
    if (err instanceof ApprovalError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    reportError("GET /api/approvals/review failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
