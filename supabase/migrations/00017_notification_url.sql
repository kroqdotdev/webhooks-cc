-- ============================================================================
-- Migration 00017: Add notification_url to endpoints
--
-- Optional URL that receives a POST with a JSON summary after each webhook
-- is captured. Enables Slack, Discord, Teams, or any webhook-compatible
-- service to alert developers instantly.
-- ============================================================================

alter table public.endpoints
  add column if not exists notification_url text;
