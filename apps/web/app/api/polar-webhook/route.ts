import { PolarConfigError, getPolarWebhookSecret } from "@/lib/polar";
import { applyPolarWebhookEvent } from "@/lib/supabase/billing";
import { applyTeamPolarWebhookEvent, extractTeamIdFromWebhook } from "@/lib/supabase/team-billing";
import { SDKValidationError } from "@polar-sh/sdk/models/errors/sdkvalidationerror";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";

function toHeaderRecord(request: Request): Record<string, string> {
  return Object.fromEntries(
    Array.from(request.headers.entries(), ([key, value]) => [key.toLowerCase(), value])
  );
}

export async function POST(request: Request) {
  let body: string;
  try {
    body = await request.text();
  } catch {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }

  try {
    const event = validateEvent(body, toHeaderRecord(request), getPolarWebhookSecret());

    // Team-customer events carry their team id in the payload (customer metadata,
    // a `team:` external id, or seat metadata on bare customer_seat.* payloads).
    // Pass the raw event data through — reshaping it would strip seat routing keys.
    const data = event.data as Record<string, unknown>;
    const teamId = extractTeamIdFromWebhook(data);
    if (teamId) {
      await applyTeamPolarWebhookEvent(event.type, teamId, data);
    } else {
      await applyPolarWebhookEvent(event.type, event.data);
    }

    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    if (error instanceof SDKValidationError) {
      console.error("Polar webhook payload validation failed:", error);
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Polar webhook misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Polar webhook processing failed:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
