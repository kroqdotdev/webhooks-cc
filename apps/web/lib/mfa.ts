/**
 * Two-factor sign-in (GoTrue TOTP). Anyone can turn it on under Account,
 * Security; staff need it for /ops. A session that signed in with a password
 * only is at assurance level aal1; after the code it is aal2.
 *
 * The level is read from the access token's claims after GoTrue has
 * validated the token (getUser), so the claims can be trusted here.
 */

interface UserWithFactors {
  factors?: { status?: string }[] | null;
}

/** The claims of a JWT that has already been validated. Null when unreadable. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The session's assurance level: "aal2" after a second factor, else "aal1". */
export function sessionAal(token: string): "aal1" | "aal2" {
  return jwtClaims(token)?.aal === "aal2" ? "aal2" : "aal1";
}

export function hasVerifiedFactor(user: UserWithFactors): boolean {
  return (user.factors ?? []).some((factor) => factor.status === "verified");
}

/** True when the account has a second factor and this session has not used it. */
export function needsSecondFactor(user: UserWithFactors, token: string): boolean {
  return hasVerifiedFactor(user) && sessionAal(token) !== "aal2";
}
