-- Billing period reset support for the Supabase migration.
-- Replaces the old Convex billing reset cron with a minute-based pg_cron job.

create extension if not exists pg_cron;

create or replace function public.process_billing_period_resets()
returns table(processed integer, downgraded integer, renewed integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  downgraded_count integer := 0;
  renewed_count integer := 0;
begin
  with downgraded_users as (
    update public.users
    set
      plan = 'free',
      subscription_status = null,
      request_limit = 50,
      requests_used = 0,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      polar_subscription_id = null
    where plan = 'pro'
      and cancel_at_period_end = true
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select count(*) into downgraded_count from downgraded_users;

  with renewed_users as (
    update public.users
    set
      requests_used = 0,
      period_start = period_end,
      period_end = period_end + interval '30 days'
    where plan = 'pro'
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select count(*) into renewed_count from renewed_users;

  return query
  select downgraded_count + renewed_count, downgraded_count, renewed_count;
end;
$$;

select cron.schedule(
  'billing-period-resets-every-minute',
  '* * * * *',
  'select public.process_billing_period_resets();'
);
