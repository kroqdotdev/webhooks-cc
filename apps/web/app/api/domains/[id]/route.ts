import { auditDomain, domainAccount, domainErrorResponse } from "@/lib/domain-route";
import { deleteDomain, setDomainRouting, type DomainRoute } from "@/lib/supabase/inbound-domains";
import { isUuid } from "@/lib/uuid";

/**
 * PATCH /api/domains/{id} { catchAllEndpointId, routes: [{ localPart, endpointId }] }:
 * where the domain's mail goes. DELETE: removes the domain; its mail is
 * refused from then on.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await domainAccount(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Domain not found" }, { status: 404 });

  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  const catchAll = body?.catchAllEndpointId;
  const routes = body?.routes;
  if (
    !body ||
    (catchAll !== null && (typeof catchAll !== "string" || !isUuid(catchAll))) ||
    !Array.isArray(routes) ||
    !routes.every(
      (route): route is DomainRoute =>
        !!route &&
        typeof route === "object" &&
        typeof (route as DomainRoute).localPart === "string" &&
        (route as DomainRoute).localPart.length <= 64 &&
        typeof (route as DomainRoute).endpointId === "string" &&
        isUuid((route as DomainRoute).endpointId)
    )
  ) {
    return Response.json(
      { error: "Send { catchAllEndpointId: id or null, routes: [{ localPart, endpointId }] }." },
      { status: 400 }
    );
  }
  try {
    const domain = await setDomainRouting(context.account, id, {
      catchAllEndpointId: catchAll as string | null,
      routes: routes as DomainRoute[],
    });
    await auditDomain(request, context.userId, context.account, "domain.routing_changed", 200, {
      domain: domain.domain,
      routes: domain.routes.length,
      catchAll: domain.catchAllEndpointId !== null,
    });
    return Response.json({ domain });
  } catch (error) {
    return domainErrorResponse(error, "Changing a domain's routing failed");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await domainAccount(request);
  if (context instanceof Response) return context;
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Domain not found" }, { status: 404 });
  try {
    await deleteDomain(context.account, id);
    await auditDomain(request, context.userId, context.account, "domain.deleted", 204, { id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return domainErrorResponse(error, "Removing a domain failed");
  }
}
