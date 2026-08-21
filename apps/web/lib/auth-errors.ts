import { isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * User-facing copy for the GoTrue error codes the email/password flows
 * (sign-in, sign-up, forgot/reset password) can surface. Strictly an
 * allowlist: any other code, and any non-GoTrue failure, collapses to the
 * generic message so backend detail never reaches the page.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password",
  user_not_found: "Incorrect email or password",
  email_not_confirmed: "Confirm your email first. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Sign in instead.",
  email_exists: "An account with this email already exists. Sign in instead.",
  weak_password: "Password must be at least 8 characters",
  same_password: "Choose a password you haven't used before",
  email_address_invalid: "Enter a valid email address",
  email_address_not_authorized: "This email address can't be used to sign up",
  validation_failed: "Check the email address and password and try again",
  signup_disabled: "New sign-ups are turned off right now",
  email_provider_disabled: "Email sign-in is not available right now",
  otp_expired: "That link has expired. Request a new one.",
  user_banned: "This account has been disabled",
  session_expired: "Your session has expired. Sign in again.",
  session_not_found: "Your session has expired. Sign in again.",
  reauthentication_needed: "Sign in again before changing your password",
  captcha_failed: "CAPTCHA verification failed. Try again.",
  over_email_send_rate_limit: "Too many emails sent. Wait a minute and try again.",
  over_request_rate_limit: "Too many attempts. Wait a moment and try again.",
};

const GENERIC_AUTH_ERROR = "Something went wrong. Please try again.";
const OFFLINE_AUTH_ERROR =
  "Couldn't reach the sign-in service. Check your connection and try again.";

export function mapAuthError(error: unknown): string {
  if (isAuthRetryableFetchError(error)) return OFFLINE_AUTH_ERROR;
  if (isAuthError(error) && error.code) {
    return AUTH_ERROR_MESSAGES[error.code] ?? GENERIC_AUTH_ERROR;
  }
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
