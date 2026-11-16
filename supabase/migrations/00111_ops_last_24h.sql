-- 00111: a "Last 24h" column on the ops overview
--
-- The overview never counts `requests` (captures can be deleted soon after
-- delivery, and refused captures never become rows); its usage numbers come
-- from endpoint_daily_stats, which counts per endpoint and UTC day. A
-- rolling 24 hours cuts yesterday in two, so the web app's hourly ops job
-- (lib/ops/metrics.ts) now also keeps a snapshot of today's counters per
-- account, and of the paying accounts, each hour:
--
--   ops_snapshots        one row per snapshot: when, and the UTC day
--   ops_snapshot_counts  that day's counters so far, per account (a null
--                        user_id is the guests, one row of their own)
--   ops_snapshot_paid    the paying accounts at that moment
--
-- ops_take_snapshot() writes one and drops those older than three days.
-- ops_last_24h() picks the snapshot nearest to 24 hours ago (within 90
-- minutes; the job runs hourly from process start, so usually within 30)
-- and answers the counters since then as the live counters of the days from
-- the snapshot's day to today minus the snapshot. With no snapshot in that
-- range (the first day after this migration, or the job down for hours) the
-- snapshot-based values are null and the page shows a dash.
--
-- Signups and the activation cohort are exact over the last 24 hours from
-- users.created_at, as ops_today() reads it. Staff and internal accounts are
-- left out everywhere, as ops_rollup_day() leaves them out.
--
-- Everything is service-role only. Re-runnable. Apply in autocommit mode.
-- ============================================================================


-- 1. Snapshots ---------------------------------------------------------------

create table if not exists public.ops_snapshots (
  taken_at timestamptz primary key,
  day      date not null
);

create table if not exists public.ops_snapshot_counts (
  taken_at       timestamptz not null
                 references public.ops_snapshots (taken_at) on delete cascade,
  -- No foreign key: a deleted account's counters stay in the snapshot, as
  -- endpoint_daily_stats keeps them (under a null user_id).
  user_id        uuid,
  captured       bigint not null default 0,
  quota_rejected bigint not null default 0,
  -- Leads with taken_at, so it also serves the cascade and the reads.
  constraint ops_snapshot_counts_key unique nulls not distinct (taken_at, user_id)
);

create table if not exists public.ops_snapshot_paid (
  taken_at timestamptz not null
           references public.ops_snapshots (taken_at) on delete cascade,
  account  text not null,
  primary key (taken_at, account)
);

alter table public.ops_snapshots enable row level security;
alter table public.ops_snapshot_counts enable row level security;
alter table public.ops_snapshot_paid enable row level security;
revoke all on table public.ops_snapshots from public, anon, authenticated;
revoke all on table public.ops_snapshot_counts from public, anon, authenticated;
revoke all on table public.ops_snapshot_paid from public, anon, authenticated;
grant select, insert, delete on table public.ops_snapshots to service_role;
grant select, insert, delete on table public.ops_snapshot_counts to service_role;
grant select, insert, delete on table public.ops_snapshot_paid to service_role;


-- 2. The paying accounts now -------------------------------------------------

-- The same rule as the end-of-day snapshot in ops_rollup_day() (00108): an
-- account on a paid plan with a Polar subscription, a team with a live
-- Polar subscription, staff and internal accounts left out. Change the two
-- together.
create or replace function public.ops_paid_now()
returns table (account text)
language sql
stable
security definer set search_path = ''
as $$
  select 'u:' || u.id::text
    from public.users u
   where u.plan <> 'free' and u.polar_subscription_id is not null
     and u.id not in (select x.user_id from public.ops_excluded_users() x)
  union
  select 't:' || t.id::text
    from public.teams t
   where t.subscription_status is not null and t.polar_subscription_id is not null
     and t.created_by not in (select x.user_id from public.ops_excluded_users() x);
$$;

revoke all on function public.ops_paid_now() from public, anon, authenticated;
grant execute on function public.ops_paid_now() to service_role;


-- 3. Taking a snapshot -------------------------------------------------------

create or replace function public.ops_take_snapshot()
returns timestamptz
language plpgsql
security definer set search_path = ''
as $$
declare
  v_at  timestamptz := now();
  v_day date := (now() at time zone 'UTC')::date;
begin
  delete from public.ops_snapshots where taken_at < v_at - interval '3 days';

  insert into public.ops_snapshots (taken_at, day) values (v_at, v_day)
  on conflict do nothing;
  if not found then
    return v_at;
  end if;

  -- Today's counters so far, on the per-day index.
  insert into public.ops_snapshot_counts (taken_at, user_id, captured, quota_rejected)
  select v_at, s.user_id, sum(s.captured), sum(s.quota_rejected)
    from public.endpoint_daily_stats s
   where s.day = v_day
     and (s.user_id is null
          or s.user_id not in (select x.user_id from public.ops_excluded_users() x))
   group by s.user_id;

  insert into public.ops_snapshot_paid (taken_at, account)
  select v_at, p.account from public.ops_paid_now() p;

  return v_at;
end;
$$;

revoke all on function public.ops_take_snapshot() from public, anon, authenticated;
grant execute on function public.ops_take_snapshot() to service_role;


-- 4. The last 24 hours -------------------------------------------------------

-- Cheap enough for every page load: the users table (as ops_today() reads
-- it), at most three days of endpoint_daily_stats on its per-day index, and
-- the snapshot tables.
create or replace function public.ops_last_24h()
returns table (
  snapshot_at      timestamptz,
  signups          bigint,
  cohort_signups   bigint,
  cohort_activated bigint,
  active_accounts  bigint,
  captured         bigint,
  quota_rejected   bigint,
  paid_accounts    bigint,
  new_paid         bigint,
  lost_paid        bigint
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  -- Stands for the guests' null user_id in the joins below.
  c_guest  constant uuid := '00000000-0000-0000-0000-000000000000';
  v_now    timestamptz := now();
  v_target timestamptz := now() - interval '24 hours';
  v_today  date := (now() at time zone 'UTC')::date;
  v_day    date;
begin
  select o.taken_at, o.day into snapshot_at, v_day
    from public.ops_snapshots o
   where o.taken_at between v_target - interval '90 minutes'
                        and v_target + interval '90 minutes'
   order by abs(extract(epoch from o.taken_at - v_target))
   limit 1;

  select count(*) into signups
    from public.users u
   where u.created_at >= v_target
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  -- Accounts that signed up between 8 and 7 days ago, and how many of them
  -- captured something within their first 7 UTC days, by the rule
  -- ops_rollup_day() applies to a day's cohort. Every such week has ended.
  select count(*),
         count(*) filter (where exists (
           select 1 from public.endpoint_daily_stats s
            where s.user_id = u.id
              and s.day between (u.created_at at time zone 'UTC')::date
                            and (u.created_at at time zone 'UTC')::date + 6
              and s.captured > 0
         ))
    into cohort_signups, cohort_activated
    from public.users u
   where u.created_at >= v_now - interval '8 days'
     and u.created_at < v_now - interval '7 days'
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  select count(*) into paid_accounts from public.ops_paid_now();

  if snapshot_at is null then
    return next;
    return;
  end if;

  with live as (
    select coalesce(s.user_id, c_guest) as account,
           sum(s.captured)::bigint as captured,
           sum(s.quota_rejected)::bigint as rejected
      from public.endpoint_daily_stats s
     where s.day between v_day and v_today
       and (s.user_id is null
            or s.user_id not in (select x.user_id from public.ops_excluded_users() x))
     group by 1
  ), snap as (
    select coalesce(c.user_id, c_guest) as account,
           c.captured,
           c.quota_rejected as rejected
      from public.ops_snapshot_counts c
     where c.taken_at = snapshot_at
       and (c.user_id is null
            or c.user_id not in (select x.user_id from public.ops_excluded_users() x))
  ), delta as (
    select coalesce(l.account, p.account) as account,
           coalesce(l.captured, 0) - coalesce(p.captured, 0) as captured,
           coalesce(l.rejected, 0) - coalesce(p.rejected, 0) as rejected
      from live l
      full join snap p on p.account = l.account
  )
  select greatest(coalesce(sum(d.captured), 0), 0)::bigint,
         greatest(coalesce(sum(d.rejected), 0), 0)::bigint,
         count(*) filter (where d.account <> c_guest and d.captured > 0)
    into captured, quota_rejected, active_accounts
    from delta d;

  select count(*) into new_paid
    from public.ops_paid_now() n
   where not exists (select 1 from public.ops_snapshot_paid p
                      where p.taken_at = snapshot_at and p.account = n.account);
  select count(*) into lost_paid
    from public.ops_snapshot_paid p
   where p.taken_at = snapshot_at
     and not exists (select 1 from public.ops_paid_now() n where n.account = p.account)
     -- An account made staff or internal since the snapshot left the count,
     -- it did not stop paying.
     and not exists (select 1 from public.ops_excluded_users() x
                      where p.account = 'u:' || x.user_id::text)
     and not exists (select 1 from public.teams t
                       join public.ops_excluded_users() x on x.user_id = t.created_by
                      where p.account = 't:' || t.id::text);

  return next;
end;
$$;

revoke all on function public.ops_last_24h() from public, anon, authenticated;
grant execute on function public.ops_last_24h() to service_role;

notify pgrst, 'reload schema';
