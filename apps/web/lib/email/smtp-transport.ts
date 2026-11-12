import { serverEnv } from "@/lib/env";
import type { EmailMessage } from "./mailer";

/**
 * SMTP email transport (nodemailer), in production Amazon SES's SMTP endpoint
 * (see infra/supabase/gotrue-email-auth.md for the SES side). The `nodemailer`
 * package is dynamic-imported so it only loads when mail is sent.
 *
 * Connection modes (per RFC):
 *   - STARTTLS: port 587, SMTP_SECURE=false (plaintext upgraded to TLS)
 *   - Implicit TLS: port 465, SMTP_SECURE=true (TLS from the first byte)
 *
 * The visible From header is EMAIL_FROM, falling back to the legacy
 * AGENT_EMAIL_FROM (webhooks.cc <noreply@webhooks.cc>). Secrets are read only
 * from the validated server env and are never logged.
 *
 * With SES_CONFIGURATION_SET, each message names that configuration set and
 * carries its kind as a message tag (`X-SES-CONFIGURATION-SET`,
 * `X-SES-MESSAGE-TAGS`; SES removes both before delivery). The set's event
 * destinations then report bounces and complaints with the kind they were
 * about.
 *
 * A failed send is not retried here. SMTP cannot tell whether a message the
 * connection broke on was taken, and some mail (the welcome email) must never
 * go out twice, so the callers decide.
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

/** SES tag values allow letters, digits, `_`, `-`, `.` and `@`; anything else is dropped. */
function sesTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_.@-]/g, "").slice(0, 256) || "unknown";
}

/** The SES headers for a message, empty without a configuration set. */
export function sesHeaders(
  message: Pick<EmailMessage, "kind">,
  configurationSet: string | undefined
): Record<string, string> {
  if (!configurationSet) return {};
  return {
    "X-SES-CONFIGURATION-SET": configurationSet,
    "X-SES-MESSAGE-TAGS": `kind=${sesTagValue(message.kind)}`,
  };
}

/**
 * The id SES gave the message, from its reply to the message ("250 Ok <id>").
 * SES also rewrites the Message-ID header to `<id>@<region>.amazonses.com`, and
 * its bounce and complaint events name the same id. Other servers answer
 * differently, so this falls back to the Message-ID nodemailer generated.
 */
export function sesMessageId(response: string | undefined, fallback: string): string {
  const match = /^250 Ok (\S+)/.exec(response ?? "");
  return match ? match[1] : fallback;
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
 * Send a message via SMTP. Sends regardless of NODE_ENV; callers that should
 * only send in production must gate the call themselves (see mailer.ts).
 */
export async function sendViaSmtp(
  message: EmailMessage
): Promise<{ messageId: string; accepted: string[] }> {
  const env = serverEnv();
  const transport = await createTransport();

  try {
    const info = await transport.sendMail({
      from: env.EMAIL_FROM ?? env.AGENT_EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: { ...message.headers, ...sesHeaders(message, env.SES_CONFIGURATION_SET) },
    });
    return {
      messageId: sesMessageId(info.response, info.messageId),
      accepted: (info.accepted ?? []).map(String),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP delivery failed: ${reason}`);
  } finally {
    transport.close();
  }
}
