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
    });
  }
  return _serverEnv;
}
