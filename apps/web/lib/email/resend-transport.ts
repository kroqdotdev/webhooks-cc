import { serverEnv } from "@/lib/env";
import type { EmailMessage } from "./mailer";

/**
 * Resend email transport. The `resend` package is dynamic-imported so the
 * dependency is only loaded when real delivery is configured (production with
 * RESEND_API_KEY set). On failure it throws so the route maps to a 500 — the
 * OTP row is already created, so the user can re-trigger.
 */
export async function sendViaResend(message: EmailMessage, apiKey: string): Promise<void> {
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: serverEnv().AGENT_EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });

  if (error) {
    throw new Error(`Resend delivery failed: ${error.message}`);
  }
}
