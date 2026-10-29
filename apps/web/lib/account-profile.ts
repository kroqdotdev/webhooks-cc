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
  | "period_start"
  | "period_end"
  | "cancel_at_period_end"
  | "subscription_status"
  | "block_requests"
  | "credit_requests"
  | "overage_active"
  | "overage_max"
  | "overage_used"
  | "overage_period_start"
  | "billing_interval"
  | "billing_period_end"
  | "pending_plan"
  | "pending_interval"
>;

export const ACCOUNT_PROFILE_SELECT =
  "id, email, name, image, plan, requests_used, request_limit, period_start, period_end, cancel_at_period_end, subscription_status, block_requests, credit_requests, overage_active, overage_max, overage_used, overage_period_start, billing_interval, billing_period_end, pending_plan, pending_interval";
