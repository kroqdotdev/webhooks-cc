import { z } from "zod";

/**
 * Centralized environment variable validation.
 *
 * NEXT_PUBLIC_ vars are available in both server and client contexts.
 * Server-only vars (CONVEX_SITE_URL, CAPTURE_SHARED_SECRET) are only
 * validated when accessed, since they are undefined in the browser.
 *
 * Both publicEnv() and serverEnv() are lazy-evaluated on first call
 * to avoid module-level crashes in contexts where some vars are unset.
 *
 * SENTRY_DSN is the server-side DSN. NEXT_PUBLIC_SENTRY_DSN is the
 * client-side DSN (exposed to the browser). They can be the same DSN
 * or different projects; set both for full coverage.
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  NEXT_PUBLIC_WEBHOOK_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("https://webhooks.cc"),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverEnvSchema = z.object({
  CONVEX_SITE_URL: z.string().url(),
  CAPTURE_SHARED_SECRET: z.string().min(1),
  SENTRY_DSN: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

/** Validated public env vars (available in both server and client). */
let _publicEnv: z.infer<typeof publicEnvSchema> | null = null;
export function publicEnv() {
  if (!_publicEnv) {
    _publicEnv = publicEnvSchema.parse({
      NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_WEBHOOK_URL: process.env.NEXT_PUBLIC_WEBHOOK_URL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
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
      CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
      CAPTURE_SHARED_SECRET: process.env.CAPTURE_SHARED_SECRET,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  return _serverEnv;
}
