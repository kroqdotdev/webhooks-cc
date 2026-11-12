import { serverEnv } from "@/lib/env";

/**
 * The one way the web app sends email.
 *
 * In production every message goes over SMTP (`SMTP_HOST`, in production
 * Amazon SES's SMTP endpoint) and a failure throws: there is no fallback and
 * no queue, so each caller decides whether to retry (see the pollers), show
 * the error, or report it. Production never falls back to the dev transport.
 * The `nodemailer` dependency is dynamic-imported so it only loads there.
 *
 * Everywhere else (NODE_ENV !== "production", i.e. tests and local dev) the
 * dev transport is used even when SMTP_HOST is set in .env.local: it logs the
 * message (incl. any code) and records it for the integration tests to read
 * via `getLastOtpForEmail`, and never sends.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, such as Auto-Submitted on automatic notices. */
  headers?: Record<string, string>;
  /**
   * Which mail this is, as a short tag (letters, digits, `_`, `-`). It goes
   * to SES as a message tag, so a bounce or complaint event names the kind of
   * mail it was about, and into the log line of the send. Never a value that
   * identifies a person.
   */
  kind: string;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    if (!serverEnv().SMTP_HOST) {
      throw new Error("Email delivery is not configured: set SMTP_HOST in production");
    }
    const { sendViaSmtp } = await import("./smtp-transport");
    const { messageId } = await sendViaSmtp(message);
    console.info(`[email] sent kind=${message.kind} id=${messageId}`);
    return;
  }

  const { sendViaDevTransport } = await import("./dev-transport");
  sendViaDevTransport(message);
}
