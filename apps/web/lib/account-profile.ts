import type { Database } from "@/lib/supabase/database";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

export type AccountProfile = Pick<
  UserRow,
  | "id"
  | "email"
  | "name"
  | "image"
  | "plan"
  | "requests_used"
  | "request_limit"
  | "period_end"
  | "cancel_at_period_end"
  | "subscription_status"
>;

export const ACCOUNT_PROFILE_SELECT =
  "id, email, name, image, plan, requests_used, request_limit, period_end, cancel_at_period_end, subscription_status";
