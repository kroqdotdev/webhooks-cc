-- ============================================================================
-- Migration 00009: Schedule remaining cleanup cron jobs
--
-- Adds the 4 missing cron jobs that existed in Convex but weren't yet
-- scheduled via pg_cron:
--
-- 1. cleanup_old_requests        — daily at 01:00 UTC (31-day retention)
-- 2. cleanup_free_user_requests  — daily at 01:30 UTC (7-day retention)
-- 3. cleanup_expired_device_codes — every 5 min (15-min TTL)
-- 4. cleanup_expired_api_keys    — daily at 02:00 UTC (1-year TTL)
-- ============================================================================

-- 1. Schedule existing functions (defined in 00001_initial_schema.sql)

select cron.schedule(
  'cleanup-old-requests-daily',
  '0 1 * * *',
  'select public.cleanup_old_requests();'
);

select cron.schedule(
  'cleanup-free-user-requests-daily',
  '30 1 * * *',
  'select public.cleanup_free_user_requests();'
);

-- 2. Create and schedule device code cleanup

create or replace function public.cleanup_expired_device_codes()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.device_codes
  where expires_at <= now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select cron.schedule(
  'cleanup-expired-device-codes-every-5-minutes',
  '*/5 * * * *',
  'select public.cleanup_expired_device_codes();'
);

-- 3. Create and schedule API key cleanup

create or replace function public.cleanup_expired_api_keys()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.api_keys
  where expires_at is not null
    and expires_at <= now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select cron.schedule(
  'cleanup-expired-api-keys-daily',
  '0 2 * * *',
  'select public.cleanup_expired_api_keys();'
);
