import { z } from "zod";

/**
 * Centralized environment variable validation.
 *
 * NEXT_PUBLIC_ vars are available in both server and client contexts.
 * Server-only vars (CAPTURE_SHARED_SECRET, etc.) are only validated
 * when accessed, since they are undefined in the browser.
 *
 * Both publicEnv() and serverEnv() are lazy-evaluated on first call
 * to avoid module-level crashes in contexts where some vars are unset.
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_WEBHOOK_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("https://webhooks.cc"),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  // Percentage of brand-new visitors the clean style A/B split sends to clean;
  // 0 stops the split. NEXT_PUBLIC_ on purpose: Next inlines it at build time in
  // both prerendered and dynamic routes, so every page runs the same split, and
  // changing it means a rebuild and restart rather than a restart alone.
  NEXT_PUBLIC_UI_STYLE_SPLIT: z.coerce.number().int().min(0).max(100).default(0),
});

/** Blank values (an empty line in an env file) count as unset. */
function blankToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema
  );
}

const serverEnvSchema = z
  .object({
    CAPTURE_SHARED_SECRET: z.string().min(1),
    BLOG_API_SECRET: z.string().min(1).optional(),
    APPSIGNAL_PUSH_API_KEY: z.string().optional(),
    APPSIGNAL_APP_NAME: z.string().default("webhooks-cc-web"),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    RECEIVER_INTERNAL_URL: z.string().url(),
    // The receiver's private mail listener, for "Send test email" (the same
    // signed API the MX host uses). Optional: without it test emails are off.
    MAIL_INGEST_URL: z.string().url().optional(),
    // The domain endpoints receive email on (the MX host's MAIL_DOMAINS).
    EMAIL_CAPTURE_DOMAIN: z.string().min(1).default("mailhooks.cc"),
    // The notify proxy (infra/notify-proxy), shared with the receiver: email
    // forwarding goes through it so the box's IP stays hidden. Without it,
    // forwarding connects directly, with the SSRF checks in lib/forwarding.
    NOTIFY_PROXY_URL: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().url().optional()
    ),
    NOTIFY_SECRET: z.string().optional(),
    // The email forwarding worker (lib/forwarding/worker.ts). On by default;
    // turn it off for a process that should not send deliveries.
    EMAIL_FORWARDING_WORKER: z
      .union([z.boolean(), z.string()])
      .transform((v) => (typeof v === "string" ? v !== "false" && v !== "0" : v))
      .default(true),
    // Lets forwarding reach http and local addresses, to try it against a
    // local server. Ignored in production.
    FORWARDING_ALLOW_PRIVATE_TARGETS: z
      .union([z.boolean(), z.string()])
      .transform((v) => (typeof v === "string" ? v === "true" || v === "1" : v))
      .default(false),
    ENDPOINT_CREATE_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
    ENDPOINT_CREATE_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(600_000),
    MAX_EPHEMERAL_ENDPOINTS: z.coerce.number().int().min(1).default(500),
    AGENT_SANDBOX_MAX_ENDPOINTS: z.coerce.number().int().min(1).default(200),
    EPHEMERAL_TTL_HOURS: z.coerce.number().min(0.1).default(12),
    // Polar seat-based Teams product. Optional so deploys without Teams billing keep working;
    // getPolarTeamsCheckoutConfig() throws at call time when it is missing.
    POLAR_TEAMS_PRODUCT_ID: z.string().optional(),
    // Agent auth (auth.md) — all optional with defaults so existing deploys are unaffected.
    RESEND_API_KEY: z.string().optional(),
    // SMTP transport for agent OTP email (used in production when SMTP_HOST is set;
    // selection order: SMTP -> Resend -> dev-capture). Non-production always uses the
    // dev-capture transport regardless of these values.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    // STARTTLS on 587 -> false; implicit TLS on 465 -> true.
    SMTP_SECURE: z
      .union([z.boolean(), z.string()])
      .transform((v) => (typeof v === "string" ? v === "true" || v === "1" : v))
      .default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    // Shared from-address for all outbound email; AGENT_EMAIL_FROM is the
    // legacy name and remains the fallback so existing deployments keep working.
    // Blank values normalize to undefined: the transports fall back with ??,
    // and an empty From header would break delivery outright.
    EMAIL_FROM: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().optional()
    ),
    AGENT_EMAIL_FROM: z.string().default("webhooks.cc <noreply@webhooks.cc>"),
    // Emails free users whose quota ran out (lib/quota-emails.ts). Opt-in so a
    // local production build, which sends real SMTP mail, never emails users
    // in the dev database. Set it on the production host only.
    QUOTA_EMAILS_ENABLED: z
      .union([z.boolean(), z.string()])
      .transform((v) => (typeof v === "string" ? v === "true" || v === "1" : v))
      .default(false),
    AGENT_REGISTER_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
    AGENT_REGISTER_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(3_600_000),
    AGENT_IDJAG_RATE_LIMIT: z.coerce.number().int().min(1).default(60),
    AGENT_IDJAG_PROVIDERS: z.string().default("[]"),
    // Agent registration (auth.md v0.6, lib/agent). Identity assertions are
    // ES256 JWTs signed with this P-256 key (PKCS#8 PEM; newlines may be
    // written as \n). The kid defaults to the key's RFC 7638 thumbprint. A
    // retired key's public JWK (JSON) stays in /.well-known/jwks.json until its
    // assertions have expired. Without the key, registration answers
    // temporarily_unavailable.
    AGENT_ASSERTION_SIGNING_KEY: blankToUndefined(z.string().optional()),
    AGENT_ASSERTION_SIGNING_KID: blankToUndefined(z.string().max(128).optional()),
    AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK: blankToUndefined(z.string().optional()),
    // HMAC key for proof-of-work challenges (32 random bytes, base64). The
    // previous secret keeps challenges issued before a rotation valid.
    AGENT_POW_SECRET: blankToUndefined(z.string().min(32).optional()),
    AGENT_POW_SECRET_PREVIOUS: blankToUndefined(z.string().min(32).optional()),
    // Leading zero bits per sub-puzzle and the number of sub-puzzles: the
    // expected work is AGENT_POW_COUNT x 2^AGENT_POW_DIFFICULTY hashes.
    AGENT_POW_DIFFICULTY: z.coerce.number().int().min(0).max(24).default(18),
    AGENT_POW_COUNT: z.coerce.number().int().min(1).max(64).default(32),
    // Anonymous registration (the sandbox). Off answers anonymous_not_enabled.
    AGENT_ANONYMOUS_ENABLED: z
      .union([z.boolean(), z.string()])
      .transform((v) => (typeof v === "string" ? v !== "false" && v !== "0" : v))
      .default(true),
    // Anonymous registrations per hour across all clients, and per IPv4 /24
    // or IPv6 /48 (the per-address limit is AGENT_REGISTER_RATE_LIMIT).
    AGENT_ANONYMOUS_GLOBAL_RATE: z.coerce.number().int().min(1).default(100),
    AGENT_REGISTER_WIDE_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
    // Live unclaimed anonymous registrations at once (backstop).
    AGENT_MAX_LIVE_ANONYMOUS: z.coerce.number().int().min(1).default(500),
    // Per-email cap on concurrent pending verified_email OTP claims (anti-spam /
    // brute-force throttle).
    AGENT_MAX_PENDING_OTP_PER_EMAIL: z.coerce.number().int().min(1).default(3),
  })
  .superRefine((env, ctx) => {
    // Fail closed in production: a real email transport MUST be configured.
    // Otherwise sendEmail() silently falls back to the dev-capture transport
    // (which only logs the OTP and never delivers), breaking verified_email.
    if (process.env.NODE_ENV === "production" && !env.SMTP_HOST && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Production requires an email transport: set SMTP_HOST (+ SMTP_USER/SMTP_PASS) or RESEND_API_KEY.",
        path: ["SMTP_HOST"],
      });
    }
  });

/** Validated public env vars (available in both server and client). */
let _publicEnv: z.infer<typeof publicEnvSchema> | null = null;
export function publicEnv() {
  if (!_publicEnv) {
    _publicEnv = publicEnvSchema.parse({
      NEXT_PUBLIC_WEBHOOK_URL: process.env.NEXT_PUBLIC_WEBHOOK_URL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_UI_STYLE_SPLIT: process.env.NEXT_PUBLIC_UI_STYLE_SPLIT,
    });
  }
  return _publicEnv;
}

/**
 * Validated server env vars. Only call this in server contexts (API routes,
 * server components). Will throw in the browser since these vars are undefined.
 */
let _serverEnv: z.infer<typeof serverEnvSchema> | null = null;
export function serverEnv() {
  if (!_serverEnv) {
    _serverEnv = serverEnvSchema.parse({
      CAPTURE_SHARED_SECRET: process.env.CAPTURE_SHARED_SECRET,
      BLOG_API_SECRET: process.env.BLOG_API_SECRET,
      APPSIGNAL_PUSH_API_KEY: process.env.APPSIGNAL_PUSH_API_KEY,
      APPSIGNAL_APP_NAME: process.env.APPSIGNAL_APP_NAME,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      RECEIVER_INTERNAL_URL: process.env.RECEIVER_INTERNAL_URL,
      MAIL_INGEST_URL: process.env.MAIL_INGEST_URL || undefined,
      EMAIL_CAPTURE_DOMAIN: process.env.EMAIL_CAPTURE_DOMAIN || undefined,
      NOTIFY_PROXY_URL: process.env.NOTIFY_PROXY_URL,
      NOTIFY_SECRET: process.env.NOTIFY_SECRET || undefined,
      EMAIL_FORWARDING_WORKER: process.env.EMAIL_FORWARDING_WORKER,
      FORWARDING_ALLOW_PRIVATE_TARGETS: process.env.FORWARDING_ALLOW_PRIVATE_TARGETS,
      ENDPOINT_CREATE_RATE_LIMIT: process.env.ENDPOINT_CREATE_RATE_LIMIT,
      ENDPOINT_CREATE_RATE_WINDOW_MS: process.env.ENDPOINT_CREATE_RATE_WINDOW_MS,
      MAX_EPHEMERAL_ENDPOINTS: process.env.MAX_EPHEMERAL_ENDPOINTS,
      AGENT_SANDBOX_MAX_ENDPOINTS: process.env.AGENT_SANDBOX_MAX_ENDPOINTS,
      EPHEMERAL_TTL_HOURS: process.env.EPHEMERAL_TTL_HOURS,
      POLAR_TEAMS_PRODUCT_ID: process.env.POLAR_TEAMS_PRODUCT_ID,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_SECURE: process.env.SMTP_SECURE,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      EMAIL_FROM: process.env.EMAIL_FROM,
      AGENT_EMAIL_FROM: process.env.AGENT_EMAIL_FROM,
      QUOTA_EMAILS_ENABLED: process.env.QUOTA_EMAILS_ENABLED,
      AGENT_REGISTER_RATE_LIMIT: process.env.AGENT_REGISTER_RATE_LIMIT,
      AGENT_REGISTER_RATE_WINDOW_MS: process.env.AGENT_REGISTER_RATE_WINDOW_MS,
      AGENT_IDJAG_RATE_LIMIT: process.env.AGENT_IDJAG_RATE_LIMIT,
      AGENT_IDJAG_PROVIDERS: process.env.AGENT_IDJAG_PROVIDERS,
      AGENT_ASSERTION_SIGNING_KEY: process.env.AGENT_ASSERTION_SIGNING_KEY,
      AGENT_ASSERTION_SIGNING_KID: process.env.AGENT_ASSERTION_SIGNING_KID,
      AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK: process.env.AGENT_ASSERTION_PREVIOUS_PUBLIC_JWK,
      AGENT_POW_SECRET: process.env.AGENT_POW_SECRET,
      AGENT_POW_SECRET_PREVIOUS: process.env.AGENT_POW_SECRET_PREVIOUS,
      AGENT_POW_DIFFICULTY: process.env.AGENT_POW_DIFFICULTY,
      AGENT_POW_COUNT: process.env.AGENT_POW_COUNT,
      AGENT_ANONYMOUS_ENABLED: process.env.AGENT_ANONYMOUS_ENABLED,
      AGENT_ANONYMOUS_GLOBAL_RATE: process.env.AGENT_ANONYMOUS_GLOBAL_RATE,
      AGENT_REGISTER_WIDE_RATE_LIMIT: process.env.AGENT_REGISTER_WIDE_RATE_LIMIT,
      AGENT_MAX_LIVE_ANONYMOUS: process.env.AGENT_MAX_LIVE_ANONYMOUS,
      AGENT_MAX_PENDING_OTP_PER_EMAIL: process.env.AGENT_MAX_PENDING_OTP_PER_EMAIL,
    });
  }
  return _serverEnv;
}
