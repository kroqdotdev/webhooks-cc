import { extractBearerToken } from "@/lib/api-auth";
import { hasVerifiedFactor } from "@/lib/mfa";
import { passedSecondFactor } from "@/lib/mfa-session";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

/**
 * Staff are the auth user ids in the `staff` table (migration 00087), added
 * by hand with psql. Ops routes answer 404 to everyone else, so the area
 * does not announce itself, accept a browser session only (never an API key
 * or agent token), and need a session that passed two-factor sign-in.
 */

export async function isStaff(userId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("staff")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

export type StaffAuthResult =
  { success: true; userId: string } | { success: false; response: Response };

export interface StaffSession {
  userId: string;
  /** Whether the session passed the second factor. */
  aal2: boolean;
  /** Whether the account has a verified second factor at all. */
  hasFactor: boolean;
}

/** The signed-in staff member behind a session token, or null for anyone else. */
export async function staffSession(request: Request): Promise<StaffSession | null> {
  const token = extractBearerToken(request);
  if (!token || token.startsWith("whcc_")) return null;
  const {
    data: { user },
    error,
  } = await createAdminClient().auth.getUser(token);
  if (error || !user) return null;
  try {
    if (!(await isStaff(user.id))) return null;
  } catch (staffError) {
    reportError("[ops] staff lookup failed", staffError);
    return null;
  }
  return {
    userId: user.id,
    aal2: await passedSecondFactor(user, token),
    hasFactor: hasVerifiedFactor(user),
  };
}

/**
 * For every /api/ops route: a staff session with two-factor sign-in, rate
 * limited per staff member.
 */
export async function authenticateStaffRequest(request: Request): Promise<StaffAuthResult> {
  const session = await staffSession(request);
  if (!session) return { success: false, response: NOT_FOUND() };
  if (!session.aal2) {
    return {
      success: false,
      response: Response.json(
        { error: "Two-factor sign-in is required for operations.", code: "mfa_required" },
        { status: 403 }
      ),
    };
  }
  const limited = await checkRateLimitByKey(`ops:${session.userId}`, 600, 60_000);
  if (limited) return { success: false, response: limited };
  return { success: true, userId: session.userId };
}

/** Headers every ops answer carries. */
export const OPS_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function opsJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(OPS_HEADERS)) headers.set(key, value);
  return Response.json(body, { ...init, headers });
}
