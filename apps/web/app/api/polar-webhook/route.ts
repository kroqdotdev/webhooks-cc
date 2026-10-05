import { auditPolarEvent } from "@/lib/audit";
import { getPolarWebhookSecret, loggablePolarError, PolarConfigError } from "@/lib/polar";
import { applyPolarWebhookEvent } from "@/lib/supabase/billing";
import { applyTeamPolarWebhookEvent, extractTeamIdFromWebhook } from "@/lib/supabase/team-billing";
import { webhooks } from "@polar-sh/sdk/2026-10";

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
    const event = await webhooks.validateEvent(
      body,
      toHeaderRecord(request),
      getPolarWebhookSecret()
    );

    // Team-customer events carry their team id in the payload (customer metadata,
    // a `team:` external id, or seat metadata on bare customer_seat.* payloads).
    // Pass the raw event data through — reshaping it would strip seat routing keys.
    const data = event.data as unknown as Record<string, unknown>;
    const teamId = extractTeamIdFromWebhook(data);
    try {
      if (teamId) {
        await applyTeamPolarWebhookEvent(event.type, teamId, data);
      } else {
        await applyPolarWebhookEvent(event.type, event.data);
      }
    } catch (applyError) {
      // Polar redelivers on a 5xx, so a failed apply shows up as an error row
      // followed by the retry's row.
      await auditPolarEvent({ eventType: event.type, teamId, data, outcome: "error" });
      throw applyError;
    }

    await auditPolarEvent({ eventType: event.type, teamId, data, outcome: "ok" });
    return Response.json({ received: true });
  } catch (error) {
    // Both subclass PolarWebhookError, so they are checked before it.
    if (error instanceof webhooks.PolarWebhookVerificationError) {
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    // Correctly signed, but a type this SDK version does not know. Acknowledge
    // it: Polar disables an endpoint after 10 consecutive failed deliveries.
    if (error instanceof webhooks.PolarWebhookUnknownTypeError) {
      console.warn("Ignoring Polar webhook of unknown type:", error.eventType);
      return Response.json({ received: true });
    }

    if (error instanceof webhooks.PolarWebhookError) {
      console.error("Polar webhook payload could not be parsed:", error.message);
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (error instanceof PolarConfigError) {
      console.error("Polar webhook misconfigured:", error);
      return Response.json({ error: "Billing is not configured" }, { status: 500 });
    }

    console.error("Polar webhook processing failed:", loggablePolarError(error));
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
