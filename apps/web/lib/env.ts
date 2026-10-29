import { z } from "zod";
import { DEFAULT_IDJAG_MAX_AUTH_AGE_SECONDS } from "./agent/constants";

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
  // mailhooks.cc, the mail-first front door on the same app (lib/site.ts);
  // unset, the app serves webhooks.cc alone.
  NEXT_PUBLIC_MAILHOOKS_URL: blankToUndefined(z.string().url().optional()),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

/** Blank values (an empty line in an env file) count as unset. */
/**
 * One resolver as Resolver.setServers() takes it: an IPv4 or IPv6 address,
 * IPv4 with a port, or either in brackets with or without one. A list it would
 * refuse fails at startup instead of failing every domain check, which would
 * lapse every verified domain within the week.
 */
function isResolverAddress(entry: string): boolean {
  const port = (value: string) => /^\d{1,5}$/.test(value) && Number(value) <= 65_535;
  if (z.ipv4().safeParse(entry).success || z.ipv6().safeParse(entry).success) return true;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    return (
      (z.ipv4().safeParse(bracketed[1]).success || z.ipv6().safeParse(bracketed[1]).success) &&
      (bracketed[2] === undefined || port(bracketed[2]))
    );
  }
  const withPort = /^([^:]+):(\d+)$/.exec(entry);
  return withPort !== null && z.ipv4().safeParse(withPort[1]).success && port(withPort[2]);
}

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
    // Errors and log lines to StatOSS (lib/observability-start.ts); unset, nothing is sent.
    STATOSS_DSN: z.string().url().optional(),
    STATOSS_ENVIRONMENT: z.string().optional(),
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
    // Where the remote MCP server (/mcp) reaches the API from inside this
    // process; default http://127.0.0.1:$PORT (lib/mcp/hosted.ts).
    MCP_INTERNAL_API_URL: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().url().optional()
    ),
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
    // Extra request capacity (lib/capacity.ts): one-time blocks, monthly blocks,
    // monthly blocks added mid-period, and metered overage. Offered only when all
    // four are set (getCapacityProductIds()).
    POLAR_REQUEST_BLOCKS_PRODUCT_ID: z.string().optional(),
    POLAR_MONTHLY_BLOCKS_PRODUCT_ID: z.string().optional(),
    POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID: z.string().optional(),
    POLAR_OVERAGE_PRODUCT_ID: z.string().optional(),
    // Business (monthly and annual) and the Team Business add-on (migration
    // 00070). Optional: without them Business is not offered.
    POLAR_BUSINESS_PRODUCT_ID: z.string().optional(),
    POLAR_BUSINESS_ANNUAL_PRODUCT_ID: z.string().optional(),
    POLAR_TEAM_BUSINESS_PRODUCT_ID: z.string().optional(),
    // Parsed-page add-ons, the same four kinds as extra requests; offered
    // only when all four are set (getPageProductIds()).
    POLAR_PAGE_BLOCKS_PRODUCT_ID: z.string().optional(),
    POLAR_MONTHLY_PAGE_BLOCKS_PRODUCT_ID: z.string().optional(),
    POLAR_MONTHLY_PAGE_BLOCKS_ADD_PRODUCT_ID: z.string().optional(),
    POLAR_PAGE_OVERAGE_PRODUCT_ID: z.string().optional(),
    // Extra inbound domains (migration 00073): monthly units and the
    // mid-period add; offered only when both are set (getDomainProductIds()).
    POLAR_DOMAINS_PRODUCT_ID: z.string().optional(),
    POLAR_DOMAINS_ADD_PRODUCT_ID: z.string().optional(),
    // Resolvers for custom inbound domain checks (lib/supabase/inbound-domains.ts),
    // comma separated; public ones by default, so a customer's nameservers
    // never see this host.
    DOMAIN_DNS_SERVERS: blankToUndefined(
      z
        .string()
        .refine(
          (value) => {
            const entries = value.split(",").map((entry) => entry.trim());
            return entries.every((entry) => entry !== "" && isResolverAddress(entry));
          },
          { message: "DOMAIN_DNS_SERVERS takes comma separated IP addresses, with optional ports" }
        )
        .optional()
    ),
    // File drops (lib/drops): the SOCKS5 egress on the MX host,
    // socks5://user:secret@<private address>:<port>. Required in production
    // for drops to be offered; without it, development connects directly.
    FILE_DROP_PROXY_URL: blankToUndefined(z.string().url().optional()),
    // S3-compatible object storage where the receiver keeps captured email
    // (raw message and attachments, lib/storage). All four, or none; region
    // defaults to us-east-1, which S3-compatible services accept.
    OBJECT_STORAGE_ENDPOINT: blankToUndefined(z.string().url().optional()),
    OBJECT_STORAGE_REGION: blankToUndefined(z.string().default("us-east-1")),
    OBJECT_STORAGE_BUCKET: blankToUndefined(z.string().optional()),
    OBJECT_STORAGE_ACCESS_KEY_ID: blankToUndefined(z.string().optional()),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: blankToUndefined(z.string().optional()),
    // Google Sheets destinations (lib/integrations/google.ts): an OAuth web
    // client whose redirect URI is {APP_URL}/api/integrations/google/callback.
    // Without both, Sheets is not offered. The Drive picker also needs an API
    // key and the Cloud project number.
    GOOGLE_OAUTH_CLIENT_ID: blankToUndefined(z.string().optional()),
    GOOGLE_OAUTH_CLIENT_SECRET: blankToUndefined(z.string().optional()),
    GOOGLE_PICKER_API_KEY: blankToUndefined(z.string().optional()),
    GOOGLE_CLOUD_PROJECT_NUMBER: blankToUndefined(z.string().optional()),
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
    // auth.md v0.5: an ID-JAG whose auth_time is older than this answers
    // login_required, and the agent has the user sign in at the provider again.
    AGENT_IDJAG_MAX_AUTH_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(DEFAULT_IDJAG_MAX_AUTH_AGE_SECONDS),
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
    // Unclaimed service_auth registrations naming one email at a time.
    AGENT_MAX_PENDING_PER_LOGIN_HINT: z.coerce.number().int().min(1).default(3),
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
      NEXT_PUBLIC_MAILHOOKS_URL: process.env.NEXT_PUBLIC_MAILHOOKS_URL,
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
      STATOSS_DSN: process.env.STATOSS_DSN || undefined,
      STATOSS_ENVIRONMENT: process.env.STATOSS_ENVIRONMENT || undefined,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      RECEIVER_INTERNAL_URL: process.env.RECEIVER_INTERNAL_URL,
      MAIL_INGEST_URL: process.env.MAIL_INGEST_URL || undefined,
      EMAIL_CAPTURE_DOMAIN: process.env.EMAIL_CAPTURE_DOMAIN || undefined,
      NOTIFY_PROXY_URL: process.env.NOTIFY_PROXY_URL,
      NOTIFY_SECRET: process.env.NOTIFY_SECRET || undefined,
      MCP_INTERNAL_API_URL: process.env.MCP_INTERNAL_API_URL,
      EMAIL_FORWARDING_WORKER: process.env.EMAIL_FORWARDING_WORKER,
      FORWARDING_ALLOW_PRIVATE_TARGETS: process.env.FORWARDING_ALLOW_PRIVATE_TARGETS,
      ENDPOINT_CREATE_RATE_LIMIT: process.env.ENDPOINT_CREATE_RATE_LIMIT,
      ENDPOINT_CREATE_RATE_WINDOW_MS: process.env.ENDPOINT_CREATE_RATE_WINDOW_MS,
      MAX_EPHEMERAL_ENDPOINTS: process.env.MAX_EPHEMERAL_ENDPOINTS,
      AGENT_SANDBOX_MAX_ENDPOINTS: process.env.AGENT_SANDBOX_MAX_ENDPOINTS,
      EPHEMERAL_TTL_HOURS: process.env.EPHEMERAL_TTL_HOURS,
      POLAR_TEAMS_PRODUCT_ID: process.env.POLAR_TEAMS_PRODUCT_ID,
      POLAR_REQUEST_BLOCKS_PRODUCT_ID: process.env.POLAR_REQUEST_BLOCKS_PRODUCT_ID,
      POLAR_MONTHLY_BLOCKS_PRODUCT_ID: process.env.POLAR_MONTHLY_BLOCKS_PRODUCT_ID,
      POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID: process.env.POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID,
      POLAR_OVERAGE_PRODUCT_ID: process.env.POLAR_OVERAGE_PRODUCT_ID,
      POLAR_BUSINESS_PRODUCT_ID: process.env.POLAR_BUSINESS_PRODUCT_ID,
      POLAR_BUSINESS_ANNUAL_PRODUCT_ID: process.env.POLAR_BUSINESS_ANNUAL_PRODUCT_ID,
      POLAR_TEAM_BUSINESS_PRODUCT_ID: process.env.POLAR_TEAM_BUSINESS_PRODUCT_ID,
      POLAR_PAGE_BLOCKS_PRODUCT_ID: process.env.POLAR_PAGE_BLOCKS_PRODUCT_ID,
      POLAR_MONTHLY_PAGE_BLOCKS_PRODUCT_ID: process.env.POLAR_MONTHLY_PAGE_BLOCKS_PRODUCT_ID,
      POLAR_MONTHLY_PAGE_BLOCKS_ADD_PRODUCT_ID:
        process.env.POLAR_MONTHLY_PAGE_BLOCKS_ADD_PRODUCT_ID,
      POLAR_PAGE_OVERAGE_PRODUCT_ID: process.env.POLAR_PAGE_OVERAGE_PRODUCT_ID,
      POLAR_DOMAINS_PRODUCT_ID: process.env.POLAR_DOMAINS_PRODUCT_ID,
      POLAR_DOMAINS_ADD_PRODUCT_ID: process.env.POLAR_DOMAINS_ADD_PRODUCT_ID,
      DOMAIN_DNS_SERVERS: process.env.DOMAIN_DNS_SERVERS,
      FILE_DROP_PROXY_URL: process.env.FILE_DROP_PROXY_URL,
      OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT,
      OBJECT_STORAGE_REGION: process.env.OBJECT_STORAGE_REGION,
      OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET,
      OBJECT_STORAGE_ACCESS_KEY_ID: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      OBJECT_STORAGE_SECRET_ACCESS_KEY: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_PICKER_API_KEY: process.env.GOOGLE_PICKER_API_KEY,
      GOOGLE_CLOUD_PROJECT_NUMBER: process.env.GOOGLE_CLOUD_PROJECT_NUMBER,
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
      AGENT_IDJAG_MAX_AUTH_AGE_SECONDS: process.env.AGENT_IDJAG_MAX_AUTH_AGE_SECONDS,
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
      AGENT_MAX_PENDING_PER_LOGIN_HINT: process.env.AGENT_MAX_PENDING_PER_LOGIN_HINT,
      AGENT_MAX_PENDING_OTP_PER_EMAIL: process.env.AGENT_MAX_PENDING_OTP_PER_EMAIL,
    });
  }
  return _serverEnv;
}
