import type { EmailMessage } from "./mailer";

/**
 * Development / test email transport. Does NOT send.
 *
 * It logs the message (including any OTP) for local development and records the
 * last message per recipient so the integration test can read the OTP via
 * `getLastOtpForEmail` without DNS/SPF/Resend. Production never imports the
 * test hooks (it uses the Resend transport instead).
 */

/** Last delivered message keyed by lower-cased recipient email. */
const lastMessageByEmail = new Map<string, EmailMessage>();

/** Extract a 6-digit OTP from message text, if present. */
function extractOtp(text: string): string | null {
  const match = text.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

export function sendViaDevTransport(message: EmailMessage): void {
  lastMessageByEmail.set(message.to.toLowerCase(), message);

  console.log(
    `[dev-email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`
  );
}

/**
 * Test hook: return the most recent OTP sent to `email`, or null if none.
 * Only meaningful when the dev transport is active (non-production / no key).
 */
export function getLastOtpForEmail(email: string): string | null {
  const message = lastMessageByEmail.get(email.toLowerCase());
  if (!message) return null;
  return extractOtp(message.text);
}

/** Test hook: clear the recorded messages between test cases. */
export function __resetEmailTestStore(): void {
  lastMessageByEmail.clear();
}
