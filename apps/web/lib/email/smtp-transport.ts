import { serverEnv } from "@/lib/env";
import type { EmailMessage } from "./mailer";

/**
 * SMTP email transport (nodemailer). The `nodemailer` package is
 * dynamic-imported so the dependency is only loaded when SMTP delivery is
 * actually used. On failure it throws so the route maps to a 500 — the OTP row
 * is already created, so the user can re-trigger.
 *
 * Connection modes (per RFC):
 *   - STARTTLS: port 587, SMTP_SECURE=false (plaintext upgraded to TLS)
 *   - Implicit TLS: port 465, SMTP_SECURE=true (TLS from the first byte)
 *
 * Auth user is SMTP_USER (e.g. postmaster@webhooks.cc); the visible From header
 * is EMAIL_FROM, falling back to the legacy AGENT_EMAIL_FROM (e.g.
 * webhooks.cc <noreply@webhooks.cc>). Secrets are read only from the validated
 * server env / process.env and are never logged.
 *
 * `sendViaSmtp` / `verifySmtp` send/connect via SMTP regardless of NODE_ENV so
 * the deliverability test can exercise real delivery directly. Routine OTP
 * delivery is gated by the mailer (production + SMTP_HOST set) — see mailer.ts.
 */

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

function resolveSmtpConfig(): SmtpConfig {
  const env = serverEnv();

  if (!env.SMTP_HOST) {
    throw new Error("SMTP is not configured: SMTP_HOST is not set");
  }

  const port = env.SMTP_PORT ?? 587;

  return {
    host: env.SMTP_HOST,
    port,
    // Implicit TLS only on the conventional 465; everything else uses STARTTLS
    // unless SMTP_SECURE is explicitly set.
    secure: env.SMTP_SECURE ?? port === 465,
    user: env.SMTP_USER ?? "",
    pass: env.SMTP_PASS ?? "",
  };
}

async function createTransport() {
  const { host, port, secure, user, pass } = resolveSmtpConfig();
  const nodemailer = await import("nodemailer");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    // STARTTLS upgrade on non-secure connections (e.g. port 587).
    requireTLS: !secure,
    ...(user ? { auth: { user, pass } } : {}),
  });
}

/**
 * Send a message via SMTP. Sends regardless of NODE_ENV — callers that should
 * only send in production must gate the call themselves (see mailer.ts).
 *
 * Returns the provider message id and the array of accepted recipients so
 * operational checks / the deliverability test can report per-send acceptance.
 */
export async function sendViaSmtp(
  message: EmailMessage
): Promise<{ messageId: string; accepted: string[] }> {
  const transport = await createTransport();

  try {
    const info = await transport.sendMail({
      from: serverEnv().EMAIL_FROM ?? serverEnv().AGENT_EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map((a) => (typeof a === "string" ? a : a.address)),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP delivery failed: ${reason}`);
  } finally {
    transport.close();
  }
}

/**
 * Verify SMTP connectivity and authentication without sending a message.
 * Throws on failure. Used by the deliverability test and operational checks.
 */
export async function verifySmtp(): Promise<void> {
  const transport = await createTransport();

  try {
    await transport.verify();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP verification failed: ${reason}`);
  } finally {
    transport.close();
  }
}
