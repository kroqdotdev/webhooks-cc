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
});

const serverEnvSchema = z.object({
  CAPTURE_SHARED_SECRET: z.string().min(1),
  BLOG_API_SECRET: z.string().min(1).optional(),
  APPSIGNAL_PUSH_API_KEY: z.string().optional(),
  APPSIGNAL_APP_NAME: z.string().default("webhooks-cc-web"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  RECEIVER_INTERNAL_URL: z.string().url(),
  ENDPOINT_CREATE_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  ENDPOINT_CREATE_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(600_000),
  MAX_EPHEMERAL_ENDPOINTS: z.coerce.number().int().min(1).default(500),
  EPHEMERAL_TTL_HOURS: z.coerce.number().min(0.1).default(12),
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
  AGENT_EMAIL_FROM: z.string().default("webhooks.cc <noreply@webhooks.cc>"),
  AGENT_REGISTER_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
  AGENT_REGISTER_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(3_600_000),
  AGENT_IDJAG_RATE_LIMIT: z.coerce.number().int().min(1).default(60),
  AGENT_IDJAG_PROVIDERS: z.string().default("[]"),
  // Global cap on outstanding unclaimed anonymous agent keys (DoS backstop,
  // analogous to MAX_PENDING_CODES for device auth).
  AGENT_MAX_PENDING_ANONYMOUS: z.coerce.number().int().min(1).default(2000),
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
      ENDPOINT_CREATE_RATE_LIMIT: process.env.ENDPOINT_CREATE_RATE_LIMIT,
      ENDPOINT_CREATE_RATE_WINDOW_MS: process.env.ENDPOINT_CREATE_RATE_WINDOW_MS,
      MAX_EPHEMERAL_ENDPOINTS: process.env.MAX_EPHEMERAL_ENDPOINTS,
      EPHEMERAL_TTL_HOURS: process.env.EPHEMERAL_TTL_HOURS,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_SECURE: process.env.SMTP_SECURE,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      AGENT_EMAIL_FROM: process.env.AGENT_EMAIL_FROM,
      AGENT_REGISTER_RATE_LIMIT: process.env.AGENT_REGISTER_RATE_LIMIT,
      AGENT_REGISTER_RATE_WINDOW_MS: process.env.AGENT_REGISTER_RATE_WINDOW_MS,
      AGENT_IDJAG_RATE_LIMIT: process.env.AGENT_IDJAG_RATE_LIMIT,
      AGENT_IDJAG_PROVIDERS: process.env.AGENT_IDJAG_PROVIDERS,
      AGENT_MAX_PENDING_ANONYMOUS: process.env.AGENT_MAX_PENDING_ANONYMOUS,
      AGENT_MAX_PENDING_OTP_PER_EMAIL: process.env.AGENT_MAX_PENDING_OTP_PER_EMAIL,
    });
  }
  return _serverEnv;
}
