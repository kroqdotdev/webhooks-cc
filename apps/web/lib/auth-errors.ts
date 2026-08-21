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
 * The `?error=` query param on /login carries either a fixed message from our
 * own route handlers (/auth/confirm), an OAuth provider's error_description
 * (forwarded by /auth/callback), or the bare `auth_callback_error` code.
 * Returns display copy, or null when there is nothing to show.
 */
export function describeLoginError(param: string | null): string | null {
  if (!param) return null;
  const value = param.trim();
  if (!value) return null;
  if (value === "auth_callback_error") return "Sign in failed. Please try again.";
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
