import { auditDomain, domainAccount, domainErrorResponse } from "@/lib/domain-route";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { addDomain, listDomains } from "@/lib/supabase/inbound-domains";

/**
 * GET /api/domains[?team=<id>]: the account's custom inbound domains, with
 * the DNS records to add and their routing. POST { domain }: adds one,
 * pending until its records are verified (Business or Team Business).
 */
export async function GET(request: Request) {
  const context = await domainAccount(request);
  if (context instanceof Response) return context;
  try {
    return Response.json({ domains: await listDomains(context.account) });
  } catch (error) {
    return domainErrorResponse(error, "Listing domains failed");
  }
}

export async function POST(request: Request) {
  const context = await domainAccount(request);
  if (context instanceof Response) return context;
  const limited = await checkRateLimitByKeyWithInfo(`user:domains-add:${context.userId}`, 10);
  if (limited.response) return limited.response;

  let domain: unknown;
  try {
    domain = ((await request.json()) as { domain?: unknown } | null)?.domain;
  } catch {
    domain = undefined;
  }
  if (typeof domain !== "string" || domain.length > 300) {
    return Response.json({ error: "Send { domain }." }, { status: 400 });
  }
  try {
    const added = await addDomain(context.account, domain);
    await auditDomain(request, context.userId, context.account, "domain.added", 201, {
      domain: added.domain,
    });
    return Response.json({ domain: added }, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error, "Adding a domain failed");
  }
}
