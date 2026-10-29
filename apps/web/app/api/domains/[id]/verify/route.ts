import { auditDomain, domainAccount, domainErrorResponse } from "@/lib/domain-route";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { verifyDomain } from "@/lib/supabase/inbound-domains";
import { isUuid } from "@/lib/uuid";

/**
 * POST /api/domains/{id}/verify: looks the domain's TXT and MX records up
 * now. Both in place: it is verified and starts receiving mail within about
 * a minute. The answer says which records are still missing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await domainAccount(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Domain not found" }, { status: 404 });
  // DNS lookups, per account.
  const limited = await checkRateLimitByKeyWithInfo(`user:domains-verify:${context.userId}`, 20);
  if (limited.response) return limited.response;
  try {
    const result = await verifyDomain(context.account, id);
    if (result.domain.status === "verified") {
      await auditDomain(request, context.userId, context.account, "domain.verified", 200, {
        domain: result.domain.domain,
      });
    }
    return Response.json(result);
  } catch (error) {
    return domainErrorResponse(error, "Verifying a domain failed");
  }
}
