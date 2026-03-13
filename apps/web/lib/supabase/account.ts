import { createAdminClient } from "./admin";

export async function deleteAccountForUser(userId: string): Promise<void> {
  const admin = createAdminClient();

  const { error: requestsError } = await admin.from("requests").delete().eq("user_id", userId);
  if (requestsError) {
    throw requestsError;
  }

  const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    throw deleteUserError;
  }
}
