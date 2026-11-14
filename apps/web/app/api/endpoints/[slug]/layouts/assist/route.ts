import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { requestApproval } from "@/lib/approvals/request";
import {
  AssistRefusal,
  assistsLeft,
  parseAssistInput,
  runEndpointAssist,
} from "@/lib/ai/endpoint-assist";
import { aiOffered } from "@/lib/ai/model";
import { jsonObject, ownedEndpoint } from "@/lib/forwarding/destination-routes";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";

/**
 * AI setup and repair (lib/ai/endpoint-assist.ts) for an endpoint's layouts
 * and fields. GET: whether it is offered, how many assists are left in the
 * rolling 30 days, and when the next one comes back (nextAt); any key of
 * the owner may read it. POST { ask, requestIds, consent: true }: sends the
 * picked emails (1 to 5 of the endpoint's own) to the model and answers only
 * proposals that compile and find a value in every sample; nothing is saved.
 * Sending the emails is the owner's consent to give: with a browser session
 * on the request (consent: true), and with an API key or agent token as an
 * approval (`ai.assist`) that runs when the owner approves it. The owner
 * only, like the layouts themselves.
 */

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  try {
    const endpoint = await ownedEndpoint(auth.userId, slug);
    if (!endpoint) return Response.json({ error: "Endpoint not found" }, { status: 404 });
    return Response.json({ offered: aiOffered(), ...(await assistsLeft(endpoint.id)) });
  } catch (error) {
    reportError("Reading AI assists failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { slug } = await params;
  const limited = await checkRateLimitByKeyWithInfo(`user:ai-assist:${auth.userId}`, 10);
  if (limited.response) return limited.response;
  if (!aiOffered()) {
    return Response.json({ error: "AI setup is not available on this server." }, { status: 404 });
  }

  const body = await jsonObject(request, 8 * 1024);
  if (body instanceof Response) return body;
  const input = parseAssistInput(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });

  // An API key or agent token: the owner sees which emails would go to the
  // model and approves; it runs then.
  if (auth.keyId) {
    return requestApproval(
      request,
      { userId: auth.userId, keyId: auth.keyId, agentRegistrationId: auth.agentRegistrationId },
      "ai.assist",
      { slug, ...input }
    );
  }

  if (body.consent !== true) {
    return Response.json(
      { error: "Agree to send the emails to the AI service first (consent: true)." },
      { status: 400 }
    );
  }
  try {
    const result = await runEndpointAssist(auth.userId, slug, input);
    await auditUserAction(request, auth.userId, {
      action: "endpoint.ai_assist",
      status: 200,
      targetId: slug,
      // What was asked and how it went; never the emails or the patterns.
      metadata: {
        kind: input.ask.kind,
        samples: input.requestIds.length,
        proposed: result.fields.length,
        dropped: result.dropped,
      },
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof AssistRefusal) {
      return Response.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status }
      );
    }
    reportError("An AI assist failed", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
