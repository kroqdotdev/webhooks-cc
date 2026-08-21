import { isAuthError } from "@supabase/supabase-js";

/**
 * User-facing copy for GoTrue error codes surfaced by the email/password
 * flows (sign-in, sign-up, forgot/reset password). Unknown codes fall back to
 * the error's own message so nothing is swallowed.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password",
  email_not_confirmed: "Confirm your email first. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Sign in instead.",
  email_exists: "An account with this email already exists. Sign in instead.",
  weak_password: "Password must be at least 8 characters",
  same_password: "Choose a password you haven't used before",
  over_email_send_rate_limit: "Too many emails sent. Wait a minute and try again.",
  over_request_rate_limit: "Too many attempts. Wait a moment and try again.",
};

const GENERIC_AUTH_ERROR = "Something went wrong. Please try again.";

export function mapAuthError(error: unknown): string {
  if (isAuthError(error)) {
    const mapped = error.code ? AUTH_ERROR_MESSAGES[error.code] : undefined;
    if (mapped) return mapped;
    return error.message || GENERIC_AUTH_ERROR;
  }
  if (error instanceof Error && error.message) return error.message;
  return GENERIC_AUTH_ERROR;
}

/**
 * Codes our own route handlers put in `/login?error=` (OAuth callback and
 * email-link confirm). Only these render; anything else (including free text)
 * collapses to the generic message so the query string can never inject
 * arbitrary copy into the page.
 */
export const LOGIN_ERROR_CODES = {
  auth_callback_error: "Sign in failed. Please try again.",
  oauth_denied: "Sign in was cancelled. Try again when you're ready.",
  oauth_error: "The sign-in provider returned an error. Please try again.",
  link_invalid: "That link is invalid or has expired. Sign in, or request a new link.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_CODES;

export function describeLoginError(param: string | null): string | null {
  if (!param) return null;
  const value = param.trim();
  if (!value) return null;
  return LOGIN_ERROR_CODES[value as LoginErrorCode] ?? LOGIN_ERROR_CODES.auth_callback_error;
}
