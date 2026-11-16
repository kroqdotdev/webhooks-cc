-- ============================================================================
-- 00108: complimentary Team Business for teams staff own
-- ============================================================================
-- Staff accounts are on Business without a Polar subscription (00087). This
-- does the same for the teams they own, so staff can use and test teams on
-- production: a team whose owner member is staff and that has no Polar
-- subscription is live on Team Business, monthly, with 10 seats (which also
-- cap its members), the request limit team_request_limit() gives that, and a
-- plain 30-day quota period. process_billing_period_resets() rolls that
-- period forward like any monthly team's, and never ends it, because a
-- staff team never has cancel_at_period_end set.
--
-- Ownership is the team_members row with role 'owner'. The app never moves
-- it, but a change made by hand is followed: a team that stops being owned
-- by staff and has no subscription goes back to suspended (no
-- subscription_status, no seats), as staff_apply_plan() puts a former staff
-- account without a subscription back on Free. Adding or removing a staff
-- row applies the same to every team that person owns.
--
-- A team with a Polar subscription is left to Polar, staff-owned or not; if
-- that subscription ends, the team becomes complimentary again.
--
-- 1. team_is_staff_owned(team): whether the team's owner member is staff.
-- 2. teams_keep_staff_plan(): a BEFORE UPDATE trigger on teams, last by name
--    (after team_request_limit(), whose limit it computes again for the
--    seats and plan it sets), that keeps a staff team without a
--    subscription on that state on every write that would change it.
--    Captures, which only move usage columns, never fire it.
-- 3. apply_staff_team_plan(team, was_staff): makes a staff team live, and
--    suspends one that was a staff team (its owner was staff) and no longer
--    is, run when an owner membership or a staff row changes. A team that
--    never had a staff owner is never touched, whatever its state.
-- 4. Existing staff-owned teams without a subscription are made live.
-- 5. ops_rollup_day() counts a team as paying only with a Polar
--    subscription, as it does an account.
--
-- Everything is service-role only. Re-runnable. Apply in autocommit mode.
-- ============================================================================


-- 1. Who owns the team -------------------------------------------------------

create or replace function public.team_is_staff_owned(p_team_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.team_members m
      join public.staff s on s.user_id = m.user_id
     where m.team_id = p_team_id
       and m.role = 'owner'
  );
$$;

revoke all on function public.team_is_staff_owned(uuid) from public, anon, authenticated;
grant execute on function public.team_is_staff_owned(uuid) to service_role;


-- 2. Keeping a staff team on Team Business -----------------------------------

create or replace function public.teams_keep_staff_plan()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_per_seat integer;
  v_pool     integer;
begin
  if new.polar_subscription_id is not null
     or not public.team_is_staff_owned(new.id) then
    return new;
  end if;

  new.subscription_status := 'active';
  new.business := true;
  new.seats := 10;
  new.pending_seats := null;
  new.pending_seats_as_of := null;
  new.cancel_at_period_end := false;
  new.pending_plan := null;
  new.pending_interval := null;
  new.prorated_window := null;
  new.prorated_seat_requests := null;
  new.prorated_seat_pages := null;
  new.pending_checkout := null;
  -- Monthly, with no billing period of its own: the quota period is the
  -- only period, and the period job rolls it forward.
  new.billing_interval := 'month';
  new.billing_period_end := null;
  new.paid_since := coalesce(new.paid_since, now());
  if new.period_end is null then
    new.period_start := now();
    new.period_end := now() + interval '30 days';
    new.requests_used := 0;
  end if;

  -- team_request_limit() ran before this trigger, on the values it was given.
  select pe.request_limit, pe.pool_requests into v_per_seat, v_pool
    from public.plan_entitlements pe
   where pe.key = 'team_business';
  if found then
    new.request_limit := new.seats::bigint * v_per_seat + v_pool;
  end if;
  return new;
end;
$$;

revoke all on function public.teams_keep_staff_plan() from public, anon, authenticated;

-- BEFORE triggers fire in name order: this one runs after teams_request_limit.
drop trigger if exists teams_zz_keep_staff_plan on public.teams;
create trigger teams_zz_keep_staff_plan
  before update on public.teams
  for each row
  when (
    old.subscription_status is distinct from new.subscription_status
    or old.polar_subscription_id is distinct from new.polar_subscription_id
    or old.business is distinct from new.business
    or old.seats is distinct from new.seats
    or old.pending_seats is distinct from new.pending_seats
    or old.request_limit is distinct from new.request_limit
    or old.cancel_at_period_end is distinct from new.cancel_at_period_end
    or old.period_end is distinct from new.period_end
    or old.pending_plan is distinct from new.pending_plan
    or old.billing_interval is distinct from new.billing_interval
    or old.billing_period_end is distinct from new.billing_period_end
    or old.prorated_window is distinct from new.prorated_window
  )
  execute function public.teams_keep_staff_plan();


-- 3. Applying it when ownership or staff changes -----------------------------

-- A staff team without a subscription goes live. A team that was a staff
-- team (p_was_staff: its owner was staff until this change) and is no
-- longer, without a subscription, is suspended, as a team whose
-- subscription ended is. The updates name the columns they change, so the
-- column triggers (request limit, paid_since, add-ons, retention floor) run.
drop function if exists public.apply_staff_team_plan(uuid);
create or replace function public.apply_staff_team_plan(p_team_id uuid, p_was_staff boolean)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if public.team_is_staff_owned(p_team_id) then
    update public.teams t
       set subscription_status = 'active',
           business = true,
           seats = 10,
           cancel_at_period_end = false
     where t.id = p_team_id
       and t.polar_subscription_id is null;
    return;
  end if;
  if not p_was_staff then
    return;
  end if;

  update public.teams t
     set subscription_status = null,
         business = false,
         seats = 0,
         requests_used = 0,
         cancel_at_period_end = false,
         period_start = null,
         period_end = null,
         billing_interval = null,
         billing_period_end = null,
         pending_plan = null,
         pending_interval = null,
         pending_seats = null,
         pending_seats_as_of = null,
         prorated_window = null,
         prorated_seat_requests = null,
         prorated_seat_pages = null,
         block_requests = 0,
         overage_active = false
   where t.id = p_team_id
     and t.polar_subscription_id is null
     and t.subscription_status is not null;
end;
$$;

revoke all on function public.apply_staff_team_plan(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_staff_team_plan(uuid, boolean) to service_role;

-- An owner membership added, removed or moved (create_team_with_owner()
-- inserts the team first and its owner after, so this is what makes a new
-- staff team live at once).
create or replace function public.team_members_apply_staff_plan()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  -- A removed owner row always counts as a staff team ending: when a staff
  -- user is deleted, the cascade can remove their staff row before this one,
  -- and a live team with no owner and no subscription has nothing to keep
  -- it live anyway (apply_staff_team_plan() leaves subscribed teams alone).
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' then
    perform public.apply_staff_team_plan(
      old.team_id,
      tg_op = 'DELETE'
        or exists (select 1 from public.staff s where s.user_id = old.user_id)
    );
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner' then
    perform public.apply_staff_team_plan(new.team_id, false);
  end if;
  return null;
end;
$$;

revoke all on function public.team_members_apply_staff_plan() from public, anon, authenticated;

drop trigger if exists team_members_apply_staff_plan on public.team_members;
create trigger team_members_apply_staff_plan
  after insert or delete or update of role, user_id, team_id on public.team_members
  for each row
  execute function public.team_members_apply_staff_plan();

-- A staff row added or removed: every team the person owns (their teams
-- were staff teams when the row is removed).
create or replace function public.staff_apply_team_plan()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user uuid := case when tg_op = 'INSERT' then new.user_id else old.user_id end;
  v_team uuid;
begin
  for v_team in
    select m.team_id from public.team_members m
     where m.user_id = v_user and m.role = 'owner'
  loop
    perform public.apply_staff_team_plan(v_team, tg_op = 'DELETE');
  end loop;
  return null;
end;
$$;

revoke all on function public.staff_apply_team_plan() from public, anon, authenticated;

drop trigger if exists staff_apply_team_plan on public.staff;
create trigger staff_apply_team_plan
  after insert or delete on public.staff
  for each row
  execute function public.staff_apply_team_plan();


-- 4. Teams staff already own -------------------------------------------------

select public.apply_staff_team_plan(m.team_id, false)
  from public.team_members m
  join public.staff s on s.user_id = m.user_id
  join public.teams t on t.id = m.team_id
 where m.role = 'owner'
   and t.polar_subscription_id is null;


-- 5. Paying accounts in the ops metrics -------------------------------------

-- A team counts as paying only with a Polar subscription, as an account
-- does: a complimentary team is live without one. Otherwise as in 00087.
create or replace function public.ops_rollup_day(p_day date, p_snapshot boolean default false)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_start   timestamptz := p_day::timestamp at time zone 'UTC';
  v_end     timestamptz := (p_day + 1)::timestamp at time zone 'UTC';
  v_cohort  date := p_day - 7;
  v_signups integer;
  v_cohort_signups integer;
  v_cohort_activated integer;
  v_active integer;
  v_captured bigint;
  v_rejected bigint;
  v_paid integer;
  v_new integer;
  v_lost integer;
begin
  select count(*) into v_signups
    from public.users u
   where u.created_at >= v_start and u.created_at < v_end
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  select count(*),
         count(*) filter (where exists (
           select 1 from public.endpoint_daily_stats s
            where s.user_id = u.id
              and s.day between (u.created_at at time zone 'UTC')::date
                            and (u.created_at at time zone 'UTC')::date + 6
              and s.captured > 0
         ))
    into v_cohort_signups, v_cohort_activated
    from public.users u
   where u.created_at >= v_cohort::timestamp at time zone 'UTC'
     and u.created_at < (v_cohort + 1)::timestamp at time zone 'UTC'
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  select count(distinct s.user_id) filter (where s.captured > 0),
         coalesce(sum(s.captured), 0),
         coalesce(sum(s.quota_rejected), 0)
    into v_active, v_captured, v_rejected
    from public.endpoint_daily_stats s
   where s.day = p_day
     and (s.user_id is null
          or s.user_id not in (select x.user_id from public.ops_excluded_users() x));

  if p_snapshot then
    delete from public.ops_paid_accounts where day = p_day;
    insert into public.ops_paid_accounts (day, account)
    select p_day, 'u:' || u.id::text
      from public.users u
     where u.plan <> 'free' and u.polar_subscription_id is not null
       and u.id not in (select x.user_id from public.ops_excluded_users() x)
    union
    select p_day, 't:' || t.id::text
      from public.teams t
     where t.subscription_status is not null and t.polar_subscription_id is not null
       and t.created_by not in (select x.user_id from public.ops_excluded_users() x)
    on conflict do nothing;
  end if;

  if exists (select 1 from public.ops_paid_accounts p where p.day = p_day) then
    select count(*) into v_paid from public.ops_paid_accounts p where p.day = p_day;
    if exists (select 1 from public.ops_paid_accounts p where p.day = p_day - 1) then
      select count(*) into v_new
        from public.ops_paid_accounts p
       where p.day = p_day
         and not exists (select 1 from public.ops_paid_accounts q
                          where q.day = p_day - 1 and q.account = p.account);
      select count(*) into v_lost
        from public.ops_paid_accounts p
       where p.day = p_day - 1
         and not exists (select 1 from public.ops_paid_accounts q
                          where q.day = p_day and q.account = p.account);
    end if;
  end if;

  insert into public.ops_daily_metrics as m (
    day, signups, cohort_signups, cohort_activated, active_accounts, captured,
    quota_rejected, paid_accounts, new_paid, lost_paid, computed_at
  ) values (
    p_day, v_signups, v_cohort_signups, v_cohort_activated, coalesce(v_active, 0),
    v_captured, v_rejected, v_paid, v_new, v_lost, now()
  )
  on conflict (day) do update set
    signups = excluded.signups,
    cohort_signups = excluded.cohort_signups,
    cohort_activated = excluded.cohort_activated,
    active_accounts = excluded.active_accounts,
    captured = excluded.captured,
    quota_rejected = excluded.quota_rejected,
    paid_accounts = coalesce(excluded.paid_accounts, m.paid_accounts),
    new_paid = coalesce(excluded.new_paid, m.new_paid),
    lost_paid = coalesce(excluded.lost_paid, m.lost_paid),
    computed_at = now();
end;
$$;

revoke all on function public.ops_rollup_day(date, boolean) from public, anon, authenticated;
grant execute on function public.ops_rollup_day(date, boolean) to service_role;
