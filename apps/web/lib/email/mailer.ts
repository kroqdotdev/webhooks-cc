import { serverEnv } from "@/lib/env";

/**
 * Minimal email abstraction for the verified_email OTP flow.
 *
 * Transport is selected at call time, and real delivery only happens in
 * production. The selection order in production is:
 *   - SMTP (real delivery) when `SMTP_HOST` is set. The `nodemailer` dependency
 *     is dynamic-imported so it only loads when used.
 *   - Resend (real delivery) when `RESEND_API_KEY` is set. The `resend`
 *     dependency is dynamic-imported so it only loads when used.
 *   - Dev/test transport as the fallback.
 *
 * In non-production (NODE_ENV !== "production", i.e. tests and local dev) the
 * dev/test transport is ALWAYS used even when SMTP_HOST / RESEND_API_KEY are
 * set in .env.local: it logs the message (incl. OTP) and records it for the
 * integration test to read via `getLastOtpForEmail` — never sends. Use the
 * directly-importable `sendViaSmtp` / `verifySmtp` for real SMTP delivery in
 * any environment (e.g. the deliverability test).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const { SMTP_HOST, RESEND_API_KEY } = serverEnv();

  if (process.env.NODE_ENV === "production") {
    if (SMTP_HOST) {
      const { sendViaSmtp } = await import("./smtp-transport");
      await sendViaSmtp(message);
      return;
    }

    if (RESEND_API_KEY) {
      const { sendViaResend } = await import("./resend-transport");
      await sendViaResend(message, RESEND_API_KEY);
      return;
    }
  }

  const { sendViaDevTransport } = await import("./dev-transport");
  sendViaDevTransport(message);
}
