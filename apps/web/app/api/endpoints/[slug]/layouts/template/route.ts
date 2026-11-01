import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { withTemplateLayout } from "@/lib/layout-template-import";
import { layoutsProblems } from "@/lib/parsing/layouts";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database";

/**
 * POST /api/endpoints/{slug}/layouts/template { template }: adds one of the
 * ready-made layouts (lib/layout-templates.ts, the mailhooks.cc sender pages)
 * to the end of the endpoint's layouts. The layout comes from the server's
 * own list, never from the request. Owner only, like the layouts themselves.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  const limited = await checkRateLimitByKeyWithInfo(`user:layout-templates:${auth.userId}`, 30);
  if (limited.response) return limited.response;

  const body = await jsonObject(request, 1024);
  if (body instanceof Response) return body;
  if (typeof body.template !== "string") {
    return Response.json({ error: "Name a template." }, { status: 400 });
  }

  try {
    // Appended in the database under the row's lock, only while the layouts
    // are still the ones checked here: an import or edit at the same moment
    // makes this read and check again rather than write over it.
    let added: ReturnType<typeof withTemplateLayout> = null;
    for (let attempt = 0; attempt < 3 && !added; attempt++) {
      const endpoint = await ownedEndpoint(auth.userId, slug);
      if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
      const next = withTemplateLayout(endpoint.layouts, body.template);
      if (!next) {
        return Response.json(
          { error: "Unknown template, or the endpoint has no room for another layout." },
          { status: 400 }
        );
      }
      const [problem] = layoutsProblems(next.layouts);
      if (problem) return Response.json({ error: `layouts: ${problem}` }, { status: 400 });
      const { data: appended, error } = await createAdminClient().rpc("append_endpoint_layout", {
        p_endpoint_id: endpoint.id,
        p_layout: next.layout as unknown as Json,
        p_expected_count: endpoint.layouts.length,
      });
      if (error) throw error;
      if (appended === true) added = next;
    }
    if (!added) {
      return Response.json(
        { error: "The endpoint's layouts changed while this ran. Try again." },
        { status: 409 }
      );
    }
    await auditUserAction(request, auth.userId, {
      action: "endpoint.updated",
      status: 200,
      targetId: slug,
      metadata: { layoutTemplate: body.template },
    });
    return Response.json({ layoutId: added.layout.id }, { status: 201 });
  } catch (error) {
    reportError("Adding a layout template failed", error);
    return Response.json({ error: "Could not add the layout" }, { status: 500 });
  }
}
