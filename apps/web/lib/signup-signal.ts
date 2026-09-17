/**
 * Marks the sign-in that created an account, so the browser can report
 * account_created once the user lands on an authenticated page.
 *
 * Email signups confirm through an out-of-band link, which the user may open
 * hours later, so the age of the account says nothing useful on the client.
 * The auth routes know a signup when they see one and leave this cookie behind
 * instead; it is short lived, readable by the page, and cleared once used.
 */
export const SIGNUP_SIGNAL_COOKIE = "whk_signup";

export const SIGNUP_SIGNAL_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
} as const;

/** True once per signup: reading it clears the cookie. Client only. */
export function consumeSignupSignal(): boolean {
  if (typeof document === "undefined") return false;
  const present = document.cookie
    .split("; ")
    .some((entry) => entry === `${SIGNUP_SIGNAL_COOKIE}=1`);
  if (present) {
    document.cookie = `${SIGNUP_SIGNAL_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
  return present;
}
