import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { mxHost } from "@/lib/supabase/inbound-domains";
import { pingHeartbeat } from "./heartbeat";

/**
 * End-to-end checks for the public status page. Every few minutes a webhook
 * goes to the canary endpoint through the public capture URL, and an email
 * through the MX host's SMTP listener; each is looked up in the database,
 * removed, and only then does its heartbeat go out. A health route answers
 * while capture itself is broken (a failed insert fails open with 200, the
 * MX host can be up while its handoff to the receiver is not), so these are
 * what tell the page that a webhook or an email is actually kept.
 *
 * The canary endpoint belongs to an internal account (`users.internal`), so
 * the operations metrics, the analytics reports and the site totals leave
 * it out. Its captures count against that account's quota like any other:
 * about 600 a day, so the account needs Pro or better (Free takes 50).
 */

const EVERY_MS = 5 * 60_000;
const FIRST_AFTER_MS = 30_000;
const FIND_FOR_MS = 30_000;
const FIND_EVERY_MS = 1_000;
const SEND_TIMEOUT_MS = 15_000;
/** Past DATA the listener waits on rspamd, storage and the receiver. */
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

export type CanaryLeg = {
  label: string;
  heartbeatUrl: string | undefined;
  /** Sends the canary, with `nonce` somewhere it can be found again. */
  send: (nonce: string) => Promise<void>;
  /** The captured request's id, or null while it is not there (yet). */
  find: (nonce: string, since: Date) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
};

export type CanaryOutcome = "ok" | "send_failed" | "not_captured" | "lookup_failed";

/** One run of one leg; never throws. */
export async function runLeg(
  leg: CanaryLeg,
  options: {
    findForMs?: number;
    findEveryMs?: number;
    ping?: typeof pingHeartbeat;
    nonce?: string;
  } = {}
): Promise<CanaryOutcome> {
  const {
    findForMs = FIND_FOR_MS,
    findEveryMs = FIND_EVERY_MS,
    ping = pingHeartbeat,
    nonce = randomBytes(8).toString("hex"),
  } = options;
  // The receiver stamps a webhook and the MX host an email, each by its own
  // clock: allow for a little skew between them and this box.
  const since = new Date(Date.now() - 60_000);
  try {
    await leg.send(nonce);
  } catch (error) {
    console.warn(`[status] ${leg.label} canary not sent: ${describe(error)}`);
    return "send_failed";
  }
  const until = Date.now() + findForMs;
  let id: string | null = null;
  let lookupError: unknown;
  for (;;) {
    try {
      id = await leg.find(nonce, since);
      lookupError = undefined;
    } catch (error) {
      lookupError = error;
    }
    if (id || Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, findEveryMs));
  }
  if (!id) {
    if (lookupError) {
      console.warn(`[status] ${leg.label} canary lookup failed: ${describe(lookupError)}`);
      return "lookup_failed";
    }
    console.warn(`[status] ${leg.label} canary was sent but not captured`);
    return "not_captured";
  }
  try {
    await leg.remove(id);
  } catch (error) {
    // Retention removes it in time; the capture itself worked.
    console.warn(`[status] ${leg.label} canary not removed: ${describe(error)}`);
  }
  await ping(leg.heartbeatUrl, `${leg.label} canary`);
  return "ok";
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

/** host:port, port 25 by default. */
export function parseSmtpTarget(value: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : 25;
  if (port < 1 || port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
}

async function endpointIdFor(slug: string): Promise<string> {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`endpoint lookup failed: ${error.message}`);
  if (!data) throw new Error("the canary endpoint does not exist");
  return data.id;
}

async function removeRequest(id: string): Promise<void> {
  const { error } = await createAdminClient().from("requests").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

function webhookLeg(slug: string, endpointId: () => Promise<string>, url?: string): CanaryLeg {
  const base = publicEnv().NEXT_PUBLIC_WEBHOOK_URL.replace(/\/$/, "");
  return {
    label: "webhook",
    heartbeatUrl: url,
    send: async (nonce) => {
      const response = await fetch(`${base}/w/${slug}/status-canary/${nonce}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "webhooks.cc status canary",
        },
        body: JSON.stringify({ canary: nonce }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // Drained, never cancelled (a cancel can hang Next's patched fetch).
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) throw new Error(`the receiver answered ${response.status}`);
    },
    find: async (nonce, since) => {
      const { data, error } = await createAdminClient()
        .from("requests")
        .select("id")
        .eq("endpoint_id", await endpointId())
        .gte("received_at", since.toISOString())
        .like("path", `%/status-canary/${nonce}`)
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },
    remove: removeRequest,
  };
}

function mailLeg(
  slug: string,
  endpointId: () => Promise<string>,
  smtp: { host: string; port: number },
  url?: string
): CanaryLeg {
  const env = serverEnv();
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: false,
    // STARTTLS is required and checked against the MX host's public name,
    // since the canary may connect by a private address: an expired or
    // wrong certificate fails the check like a lost message would.
    requireTLS: true,
    tls: { servername: mxHost() },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
  return {
    label: "email",
    heartbeatUrl: url,
    send: async (nonce) => {
      await transport.sendMail({
        from: "webhooks.cc status canary <status-canary@webhooks.cc>",
        to: `${slug.toLowerCase()}@${env.EMAIL_CAPTURE_DOMAIN}`,
        subject: `status canary ${nonce}`,
        text: "A check for status.webhooks.cc. It is removed as soon as it is found.",
      });
    },
    find: async (nonce, since) => {
      const { data, error } = await createAdminClient()
        .from("requests")
        .select("id")
        .eq("endpoint_id", await endpointId())
        .eq("kind", "email")
        .gte("received_at", since.toISOString())
        .eq("email->>subject", `status canary ${nonce}`)
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },
    remove: removeRequest,
  };
}

const globalForCanary = globalThis as unknown as { __statusCanary?: NodeJS.Timeout };

/**
 * Starts the canary when STATUS_CANARY_SLUG names an endpoint and at least
 * one leg has a heartbeat URL. The email leg also needs STATUS_CANARY_SMTP.
 */
export function startStatusCanary(): void {
  if (globalForCanary.__statusCanary) return;
  const env = serverEnv();
  const slug = env.STATUS_CANARY_SLUG;
  if (!slug) return;
  let cachedId: string | undefined;
  const endpointId = async () => (cachedId ??= await endpointIdFor(slug));

  const legs: CanaryLeg[] = [];
  if (env.STATUS_HEARTBEAT_CAPTURE_URL) {
    legs.push(webhookLeg(slug, endpointId, env.STATUS_HEARTBEAT_CAPTURE_URL));
  }
  if (env.STATUS_HEARTBEAT_MAIL_URL && env.STATUS_CANARY_SMTP) {
    const smtp = parseSmtpTarget(env.STATUS_CANARY_SMTP);
    if (smtp) legs.push(mailLeg(slug, endpointId, smtp, env.STATUS_HEARTBEAT_MAIL_URL));
    else console.warn("[status] STATUS_CANARY_SMTP is not host:port; the email canary is off");
  }
  if (legs.length === 0) return;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const outcomes = await Promise.all(legs.map((leg) => runLeg(leg)));
      // A miss may mean the endpoint was made again under the same slug:
      // look its id up afresh next time.
      if (outcomes.some((outcome) => outcome !== "ok")) cachedId = undefined;
    } finally {
      running = false;
    }
  };
  globalForCanary.__statusCanary = setInterval(() => void run(), EVERY_MS);
  globalForCanary.__statusCanary.unref();
  setTimeout(() => void run(), FIRST_AFTER_MS).unref();
}
