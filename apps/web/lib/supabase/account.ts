import { createAdminClient } from "./admin";
import { createPolarClient, describePolarError, unwrapPolarResult } from "@/lib/polar";
import { revokeTeamSubscription } from "./team-billing";

/**
 * Thrown when account deletion cannot proceed because a live Polar subscription
 * could not be revoked. The account is left intact so the user can retry (or
 * cancel from the billing section first); the opposite order would delete the
 * rows that record the subscription ids and leave Polar charging forever.
 */
export class AccountDeletionBillingError extends Error {
  readonly code = "billing_revoke_failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountDeletionBillingError";
  }
}

function isAlreadyCanceledError(error: unknown): boolean {
  const detail = describePolarError(error) ?? (error instanceof Error ? error.message : "");
  return /already[\s_-]?(canceled|cancelled|revoked)/i.test(detail);
}

async function revokePersonalSubscription(polarSubscriptionId: string): Promise<void> {
  const polar = createPolarClient();
  try {
    const result = await polar.subscriptions.revoke({ id: polarSubscriptionId });
    unwrapPolarResult(result, "subscription revoke");
  } catch (error) {
    // A subscription Polar already ended (webhook still in flight) is fine to skip.
    if (isAlreadyCanceledError(error)) return;
    throw error;
  }
}

async function revokeOwnedTeamSubscription(polarSubscriptionId: string): Promise<void> {
  try {
    await revokeTeamSubscription(polarSubscriptionId);
  } catch (error) {
    if (isAlreadyCanceledError(error)) return;
    throw error;
  }
}

/**
 * Deletes a user account and everything it owns.
 *
 * Order matters: Polar subscriptions are revoked FIRST. `teams.created_by`
 * cascades on user delete, so a team this user created (and therefore owns)
 * disappears with the account, and the personal `users` row goes with the auth
 * user. Nothing would be left to reconcile a still-running subscription
 * against, so any revoke failure aborts the deletion with
 * {@link AccountDeletionBillingError}.
 */
export async function deleteAccountForUser(userId: string): Promise<void> {
  const admin = createAdminClient();

  // 1. Teams this user owns: stop their billing before the cascade removes them.
  const { data: ownerRows, error: ownerError } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId)
    .eq("role", "owner");
  if (ownerError) throw ownerError;

  const ownedTeamIds = (ownerRows ?? []).map((row) => row.team_id);
  if (ownedTeamIds.length > 0) {
    const { data: teams, error: teamsError } = await admin
      .from("teams")
      .select("id, polar_subscription_id")
      .in("id", ownedTeamIds);
    if (teamsError) throw teamsError;

    for (const team of teams ?? []) {
      if (!team.polar_subscription_id) continue;
      try {
        await revokeOwnedTeamSubscription(team.polar_subscription_id);
      } catch (error) {
        throw new AccountDeletionBillingError(
          `Could not cancel the subscription for team ${team.id}`,
          { cause: error }
        );
      }
    }
  }

  // 2. Personal Pro subscription.
  const { data: user, error: userError } = await admin
    .from("users")
    .select("polar_subscription_id")
    .eq("id", userId)
    .maybeSingle();
  if (userError) throw userError;

  if (user?.polar_subscription_id) {
    try {
      await revokePersonalSubscription(user.polar_subscription_id);
    } catch (error) {
      throw new AccountDeletionBillingError("Could not cancel the Pro subscription", {
        cause: error,
      });
    }
  }

  // 3. Data, then the auth user (cascades to users, endpoints, api_keys, teams).
  const { error: requestsError } = await admin.from("requests").delete().eq("user_id", userId);
  if (requestsError) {
    throw requestsError;
  }

  const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    throw deleteUserError;
  }
}
