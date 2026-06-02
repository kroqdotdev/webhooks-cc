import { serverEnv } from "@/lib/env";

/**
 * Minimal email abstraction for the verified_email OTP flow.
 *
 * Transport is selected at call time, and real delivery only happens in
 * production. Production fails closed — it never falls back to the dev/test
 * transport. The selection order in production is:
 *   - SMTP (real delivery) when `SMTP_HOST` is set. The `nodemailer` dependency
 *     is dynamic-imported so it only loads when used. If an SMTP send fails and
 *     `RESEND_API_KEY` is set, it falls back to Resend; otherwise it throws.
 *   - Resend (real delivery) when `RESEND_API_KEY` is set (and SMTP_HOST is
 *     unset). The `resend` dependency is dynamic-imported so it only loads when
 *     used.
 *   - When neither is configured (or both fail), it throws.
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
    // Production never falls back to the dev transport: it fails closed.
    if (SMTP_HOST) {
      const { sendViaSmtp } = await import("./smtp-transport");
      try {
        await sendViaSmtp(message);
        return;
      } catch (error) {
        // SMTP is primary; fall back to Resend if available, otherwise rethrow.
        if (!RESEND_API_KEY) {
          throw error;
        }
        const { sendViaResend } = await import("./resend-transport");
        await sendViaResend(message, RESEND_API_KEY);
        return;
      }
    }

    if (RESEND_API_KEY) {
      const { sendViaResend } = await import("./resend-transport");
      await sendViaResend(message, RESEND_API_KEY);
      return;
    }

    throw new Error(
      "Email delivery is not configured: set SMTP_HOST or RESEND_API_KEY in production"
    );
  }

  const { sendViaDevTransport } = await import("./dev-transport");
  sendViaDevTransport(message);
}
