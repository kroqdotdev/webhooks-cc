import { createHash, randomInt } from "node:crypto";
import { sendEmail, type EmailMessage } from "@/lib/email/mailer";
import { reportError } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import { siteOrigin, type SiteKey } from "@/lib/site";

/**
 * Recovery codes for two-factor sign-in (migration 00087). GoTrue's TOTP has
 * none, so the app keeps its own: ten one-time codes, shown once when they
 * are made and stored only as SHA-256 hashes. A code cannot raise a session
 * to aal2 (only GoTrue can), so using one removes the account's
 * authenticators instead: the person is then signed in without a second
 * factor and sets one up again. Staff can do the same from /ops for someone
 * who proved who they are another way. Either way the account is emailed.
 */

export const RECOVERY_CODE_COUNT = 10;

// No 0/O, 1/I/L: codes are read off paper. 31 symbols, 10 of them: about 49.5 bits.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** What a person typed, as stored: upper case, dashes and spaces dropped. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function hashRecoveryCode(input: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(input)).digest("hex");
}

/** Replaces the account's codes with ten new ones and returns them, once. */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const { error: deleteError } = await admin
    .from("mfa_recovery_codes")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw deleteError;
  const { error } = await admin
    .from("mfa_recovery_codes")
    .insert(codes.map((code) => ({ user_id: userId, code_hash: hashRecoveryCode(code) })));
  if (error) throw error;
  return codes;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("mfa_recovery_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("used_at", null);
  if (error) throw error;
  return count ?? 0;
}

/** Removes every authenticator of the account and its recovery codes. Returns how many factors went. */
export async function removeTwoFactor(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw error;
  let removed = 0;
  for (const factor of data?.factors ?? []) {
    const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
      id: factor.id,
      userId,
    });
    if (deleteError) throw deleteError;
    if (factor.status === "verified") removed++;
  }
  const { error: codesError } = await admin
    .from("mfa_recovery_codes")
    .delete()
    .eq("user_id", userId);
  if (codesError) throw codesError;
  // Also done by a trigger on auth.mfa_factors (migration 00088).
  await admin.from("mfa_trusted_sessions").delete().eq("user_id", userId);
  return removed;
}

/**
 * Spends a recovery code: true when it was the account's and unused, after
 * which the authenticators are gone. The code is marked used in the same
 * conditional update that finds it, so it works once even when sent twice.
 */
export async function redeemRecoveryCode(userId: string, input: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== 10) return false;
  const { data, error } = await createAdminClient()
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", hashRecoveryCode(normalized))
    .is("used_at", null)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return false;
  await removeTwoFactor(userId);
  return true;
}

export function buildTwoFactorOffEmail(params: {
  to: string;
  how: "recovery_code" | "support";
  appUrl: string;
}): EmailMessage {
  const what =
    params.how === "recovery_code"
      ? "Two-factor sign-in was turned off on your account because a recovery code was used to sign in."
      : "Support turned off two-factor sign-in on your account, as you asked.";
  const link = `${params.appUrl}/account/security`;
  const notYou = "If this was not you, reset your password now and email support@webhooks.cc.";
  return {
    to: params.to,
    kind: "two_factor_off",
    subject: "Two-factor sign-in was turned off",
    text: `${what}\n\nSet it up again: ${link}\n\n${notYou}`,
    html:
      `<p>${what}</p><p><a href="${link}">Set it up again</a> under Account, Security.</p>` +
      `<p>${notYou}</p>`,
    headers: { "Auto-Submitted": "auto-generated" },
  };
}

/** Tells the account's owner; a failure is reported, never thrown. */
export async function notifyTwoFactorOff(
  userId: string,
  how: "recovery_code" | "support"
): Promise<void> {
  try {
    const { data } = await createAdminClient()
      .from("users")
      .select("email, home_site")
      .eq("id", userId)
      .maybeSingle();
    if (!data?.email) return;
    await sendEmail(
      buildTwoFactorOffEmail({
        to: data.email,
        how,
        appUrl: siteOrigin((data.home_site ?? "webhooks") as SiteKey),
      })
    );
  } catch (error) {
    reportError("[mfa] two-factor off notice failed", error);
  }
}
