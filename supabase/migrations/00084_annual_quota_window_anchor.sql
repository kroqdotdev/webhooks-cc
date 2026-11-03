-- 00084: annual quota windows keep the year's day.
--
-- An annual plan (personal Business annual, annual Team Business) renews its
-- quota monthly inside Polar's year. process_billing_period_resets() counted
-- each new window from the previous window's end, so a year that started on
-- the 29th to the 31st lost days in a short month and never got them back
-- (Jan 31, Feb 28, Mar 28, ...), and the last window ended a few days before
-- Polar renewed the year, whose renewal then reset the usage again.
--
-- Polar keeps a subscription's day (its anchor_day) through short months,
-- and a renewal starts exactly where the year ended. So the windows are now
-- whole months counted from the end of the year, each from that end itself
-- (Jan 31 less 11 months is Feb 28, less 10 is Mar 31), and the last one
-- ends exactly when Polar renews:
--
--   1. annual_quota_window(anchor, from, at): the window holding the later
--      of from and at, starting no earlier than from. A window shorter than
--      7 days (what is left before the next boundary when a window counted
--      the old way ended off them) joins the next one, so a window that
--      drifted is put back on the year's day without a fresh allowance for a
--      few days. lib/supabase/billing.ts mirrors it (annualQuotaWindow) for
--      the year's first window, which the Polar webhook sets.
--   2. process_billing_period_resets() moves annual users and teams with it.
--
-- Apply with psql in autocommit mode, as AGENTS.md says. Re-runnable.


-- 1. The window
create or replace function public.annual_quota_window(
  p_anchor timestamptz,
  p_from timestamptz,
  p_at timestamptz,
  out window_start timestamptz,
  out window_end timestamptz
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- Counted in UTC, as the web app counts them, whatever the session's zone.
  v_anchor timestamp := p_anchor at time zone 'UTC';
  v_from   timestamp := p_from at time zone 'UTC';
  v_at     timestamp := greatest(p_from, p_at) at time zone 'UTC';
  v_n      integer;
begin
  if v_anchor is null or v_from is null then
    return;
  end if;
  -- The boundary in v_at's month, or the one before when that is later.
  v_n := (extract(year from v_at)::integer - extract(year from v_anchor)::integer) * 12
       + extract(month from v_at)::integer - extract(month from v_anchor)::integer;
  if v_anchor + make_interval(months => v_n) > v_at then
    v_n := v_n - 1;
  end if;
  window_start := greatest(v_anchor + make_interval(months => v_n), v_from) at time zone 'UTC';
  window_end := (v_anchor + make_interval(months => v_n + 1)) at time zone 'UTC';
  if window_end - window_start < interval '7 days' then
    window_end := (v_anchor + make_interval(months => v_n + 2)) at time zone 'UTC';
  end if;
end;
$$;

revoke all on function public.annual_quota_window(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.annual_quota_window(timestamptz, timestamptz, timestamptz)
  to service_role;


-- 2. The monthly reset
create or replace function public.process_billing_period_resets()
returns table(processed integer, downgraded integer, renewed integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  downgraded_count integer := 0;
  renewed_count integer := 0;
  v_free_limit integer;
begin
  select pe.request_limit into v_free_limit
    from public.plan_entitlements pe where pe.key = 'free';

  with downgraded_users as (
    update public.users u
    set
      plan = 'free',
      subscription_status = null,
      request_limit = coalesce(v_free_limit, 50),
      requests_used = 0,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      billing_interval = null,
      billing_period_end = null,
      polar_subscription_id = null,
      -- Add-ons need a plan; one-time blocks stay.
      block_requests = 0,
      overage_active = false
    where u.plan <> 'free'
      and u.cancel_at_period_end = true
      and coalesce(u.billing_period_end, u.period_end) is not null
      and coalesce(u.billing_period_end, u.period_end) <= now()
    returning u.id
  )
  select count(*) into downgraded_count from downgraded_users;

  -- Monthly plans: a fallback for a renewal webhook that has not arrived;
  -- Polar's own period replaces this one when it does.
  with renewed_users as (
    update public.users
    set
      requests_used = 0,
      period_start = period_end,
      period_end = period_end + interval '30 days',
      billing_period_end = case
        when billing_period_end is not null and billing_period_end <= period_end
          then period_end + interval '30 days'
        else billing_period_end
      end
    where plan <> 'free'
      and billing_interval is distinct from 'year'
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select count(*) into renewed_count from renewed_users;

  -- Annual plans: the quota period moves to the window holding now(), on
  -- boundaries counted from the end of Polar's year (annual_quota_window()),
  -- in one pass: a job that was down grants one fresh window, not one per
  -- missed month, and the windows keep the year's day. The billing period
  -- is Polar's and stays.
  with renewed_annual as (
    update public.users u
    set
      requests_used = 0,
      period_start = m.window_start,
      period_end = m.window_end
    from (
      select x.id, w.window_start, w.window_end
        from public.users x
        cross join lateral public.annual_quota_window(
          coalesce(x.billing_period_end, x.period_end), x.period_end, now()) w
       where x.plan <> 'free'
         and x.billing_interval = 'year'
         and x.period_end is not null
         and x.period_end <= now()
    ) m
    where u.id = m.id
      and not (u.cancel_at_period_end and coalesce(u.billing_period_end, u.period_end) <= now())
    returning u.id
  )
  select renewed_count + count(*) into renewed_count from renewed_annual;

  with deactivated_teams as (
    update public.teams t
    set
      subscription_status = null,
      polar_subscription_id = null,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      billing_interval = null,
      billing_period_end = null,
      pending_plan = null,
      pending_interval = null,
      business = false,
      block_requests = 0,
      overage_active = false
    where t.subscription_status is not null
      and t.cancel_at_period_end = true
      and coalesce(t.billing_period_end, t.period_end) is not null
      and coalesce(t.billing_period_end, t.period_end) <= now()
    returning t.id
  )
  select downgraded_count + count(*) into downgraded_count from deactivated_teams;

  -- Monthly teams: renewal advances to the first 30-day boundary after now()
  -- in one pass, so a reset job that was down for more than one interval
  -- grants a single fresh quota window instead of one reset per missed
  -- interval on consecutive runs.
  -- The billing period end moves with it, as for monthly plans, so a team
  -- that cancels before the late renewal webhook arrives is not ended at
  -- once by the deactivation step above.
  with renewed_teams as (
    update public.teams
    set
      requests_used = 0,
      period_start = period_end + interval '30 days'
        * floor(extract(epoch from (now() - period_end)) / extract(epoch from interval '30 days')),
      period_end = period_end + interval '30 days'
        * (floor(extract(epoch from (now() - period_end)) / extract(epoch from interval '30 days')) + 1),
      billing_period_end = case
        when billing_period_end is not null and billing_period_end <= period_end
          then period_end + interval '30 days'
            * (floor(extract(epoch from (now() - period_end)) / extract(epoch from interval '30 days')) + 1)
        else billing_period_end
      end
    where subscription_status is not null
      and billing_interval is distinct from 'year'
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select renewed_count + count(*) into renewed_count from renewed_teams;

  -- Annual teams: the quota period moves monthly, as for annual plans.
  with renewed_annual_teams as (
    update public.teams t
    set
      requests_used = 0,
      period_start = m.window_start,
      period_end = m.window_end
    from (
      select x.id, w.window_start, w.window_end
        from public.teams x
        cross join lateral public.annual_quota_window(
          coalesce(x.billing_period_end, x.period_end), x.period_end, now()) w
       where x.subscription_status is not null
         and x.billing_interval = 'year'
         and x.period_end is not null
         and x.period_end <= now()
    ) m
    where t.id = m.id
      and not (t.cancel_at_period_end and coalesce(t.billing_period_end, t.period_end) <= now())
    returning t.id
  )
  select renewed_count + count(*) into renewed_count from renewed_annual_teams;

  -- Add-ons whose period ended over two days ago without a renewal from
  -- Polar stop counting (sync_capacity_account ignores them; it writes only
  -- what changed).
  perform public.sync_capacity_account(s.user_id, s.team_id)
     from public.capacity_subscriptions s
    where s.status is not null
      and s.period_end < now() - interval '2 days';

  return query
  select downgraded_count + renewed_count, downgraded_count, renewed_count;
end;
$$;

revoke all on function public.process_billing_period_resets() from public, anon, authenticated;
grant execute on function public.process_billing_period_resets() to service_role;

notify pgrst, 'reload schema';
