-- 00082: Team Business is the team's own seat subscription.
--
-- Until now Team Business was a $49 add-on subscription next to the team's
-- seat subscription (00070, kind team_business in capacity_subscriptions),
-- and sync_capacity_account() turned teams.business on while both were live.
-- It is now a plan product like Teams: the team's one Polar subscription is
-- on the Teams product or on Team Business (monthly or annual), and the web
-- app writes teams.business from the product with the rest of the
-- subscription state. So:
--
--   1. plan_entitlements.per_seat: Team Business gives the Business numbers
--      per seat (requests, parsed pages and AI assists); its pool is gone.
--      account_entitlements() multiplies pages and assists by the seats for
--      such a key, so every reader (the page balance, the AI assist count)
--      gets the team's figure.
--   2. teams columns for the plan: the billing interval and the billing
--      period end (an annual team's quota still renews monthly, as an
--      annual personal plan's does), a change Polar holds for the renewal
--      (pending_plan, pending_interval), and the pro rata allowance of an
--      upgrade made mid-period (prorated_window and the per-seat requests
--      and pages for that window).
--   3. team_request_limit() reads the pro rata allowance; parsed_pages_balance()
--      reads the pro rata pages for teams too.
--   4. sync_capacity_account() no longer writes teams.business; page and
--      domain add-ons count while the team is a live Team Business team.
--   5. process_billing_period_resets(): annual teams renew their quota
--      monthly and end with the billing period, not with the month.
--   6. The team_business add-on kind is removed (production has none live;
--      this file refuses to run while one is).
--
-- lib/entitlements.ts mirrors plan_entitlements; the entitlements
-- integration test compares the two.
--
-- Apply with psql in autocommit mode, as AGENTS.md says. Re-runnable.


-- 0. Nothing may still be paying for the add-on.
do $$
begin
  if exists (
    select 1 from public.capacity_subscriptions
     where kind = 'team_business' and status is not null
  ) then
    raise exception 'a team_business add-on subscription is still live; end it in Polar first';
  end if;
end $$;


-- 1. Entitlements
alter table public.plan_entitlements
  add column if not exists per_seat boolean not null default false;

comment on column public.plan_entitlements.per_seat is
  'Team keys: parsed_pages and ai_assists are per seat too (request_limit always is).';

update public.plan_entitlements
   set request_limit = 250000,
       pool_requests = 0,
       parsed_pages = 2000,
       ai_assists = 250,
       annual_billing = true,
       per_seat = true
 where key = 'team_business'
   and (request_limit, pool_requests, parsed_pages, ai_assists, annual_billing, per_seat)
       is distinct from (250000, 0, 2000, 250, true, true);

-- A team's entitlements are its key's, with pages and assists for all its
-- seats when the key counts them per seat.
create or replace function public.account_entitlements(p_user_id uuid, p_team_id uuid)
returns public.plan_entitlements
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_ent   public.plan_entitlements;
  v_seats integer;
begin
  if p_team_id is not null then
    select pe.*
      into v_ent
      from public.teams t
      join public.plan_entitlements pe
        on pe.key = case when t.business then 'team_business' else 'team' end
     where t.id = p_team_id;
    if found and v_ent.per_seat then
      select greatest(t.seats, 1) into v_seats from public.teams t where t.id = p_team_id;
      v_ent.parsed_pages := v_ent.parsed_pages * v_seats;
      v_ent.ai_assists := v_ent.ai_assists * v_seats;
    end if;
    return v_ent;
  end if;
  select pe.*
    into v_ent
    from public.plan_entitlements pe
   where pe.key = coalesce((select u.plan from public.users u where u.id = p_user_id), 'free');
  return v_ent;
end;
$$;

revoke all on function public.account_entitlements(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_entitlements(uuid, uuid) to service_role;


-- 2. Team plan columns
alter table public.teams
  add column if not exists billing_interval text,
  add column if not exists billing_period_end timestamptz,
  add column if not exists pending_plan text,
  add column if not exists pending_interval text,
  add column if not exists prorated_window timestamptz,
  add column if not exists prorated_seat_requests integer,
  add column if not exists prorated_seat_pages integer;

comment on column public.teams.billing_interval is
  'The subscription''s interval: month, or year for annual Team Business (null while unsubscribed).';
comment on column public.teams.billing_period_end is
  'End of Polar''s billing period; period_start/period_end are the monthly quota period.';
comment on column public.teams.pending_plan is
  'The plan Polar applies at the renewal (pending_update.product_id): team or team_business.';
comment on column public.teams.prorated_window is
  'The quota period an upgrade made mid-period was granted pro rata for (prorated_seat_*).';

alter table public.teams drop constraint if exists teams_billing_interval_check;
alter table public.teams
  add constraint teams_billing_interval_check
  check (billing_interval is null or billing_interval in ('month', 'year')) not valid;

alter table public.teams drop constraint if exists teams_pending_plan_check;
alter table public.teams
  add constraint teams_pending_plan_check
  check (
    (pending_plan is null and pending_interval is null)
    or (pending_plan in ('team', 'team_business') and pending_interval in ('month', 'year'))
  ) not valid;

alter table public.teams drop constraint if exists teams_prorated_check;
alter table public.teams
  add constraint teams_prorated_check
  check (
    (prorated_window is null and prorated_seat_requests is null and prorated_seat_pages is null)
    or (prorated_window is not null and prorated_seat_requests >= 0 and prorated_seat_pages >= 0)
  ) not valid;

-- Every subscribed team so far is monthly.
update public.teams
   set billing_interval = 'month'
 where subscription_status is not null and billing_interval is null;


-- 3. A team's request limit: seats x the per-seat requests (the pro rata
-- figure in the window an upgrade was made in), plus its key's pool. When
-- the period moves on, the pro rata allowance is dropped with it. Whatever
-- writes seats, business, the period or request_limit (the subscription
-- webhook, update_team_seats(), the reset job) gets the same number.
create or replace function public.team_request_limit()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_per_seat integer;
  v_pool     integer;
begin
  if new.prorated_window is not null and new.prorated_window is distinct from new.period_start then
    new.prorated_window := null;
    new.prorated_seat_requests := null;
    new.prorated_seat_pages := null;
  end if;
  select pe.request_limit, pe.pool_requests into v_per_seat, v_pool
    from public.plan_entitlements pe
   where pe.key = case when new.business then 'team_business' else 'team' end;
  if found then
    if new.prorated_window is not null then
      v_per_seat := new.prorated_seat_requests;
    end if;
    new.request_limit := new.seats::bigint * v_per_seat + v_pool;
  end if;
  return new;
end;
$$;

revoke execute on function public.team_request_limit() from public, anon, authenticated;

drop trigger if exists teams_request_limit on public.teams;
create trigger teams_request_limit
  before insert or update of seats, business, request_limit, period_start,
    prorated_window, prorated_seat_requests on public.teams
  for each row
  execute function public.team_request_limit();

-- The pages an account has: a team's pro rata pages in the window an
-- upgrade was made in, per seat (base is 00070).
create or replace function public.parsed_pages_balance(p_user_id uuid, p_team_id uuid)
returns table (
  window_start  timestamptz,
  allowance     integer,
  used          integer,
  credits       bigint,
  overage_left  integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_ent   public.plan_entitlements;
  v_row   record;
  v_start timestamptz;
begin
  v_ent := public.account_entitlements(p_user_id, p_team_id);
  if p_team_id is not null then
    select t.period_start, t.period_end, t.pages_used, t.pages_period_start, t.credit_pages,
           t.page_block_pages, t.page_overage_active, t.page_overage_max, t.page_overage_used,
           t.page_overage_period_start, 'month'::text as quota_period,
           t.prorated_seat_pages * greatest(t.seats, 1) as prorated_pages,
           t.prorated_window
      into v_row
      from public.teams t where t.id = p_team_id;
  else
    select u.period_start, u.period_end, u.pages_used, u.pages_period_start, u.credit_pages,
           u.page_block_pages, u.page_overage_active, u.page_overage_max, u.page_overage_used,
           u.page_overage_period_start, v_ent.quota_period as quota_period,
           u.prorated_pages, u.prorated_window
      into v_row
      from public.users u where u.id = p_user_id;
  end if;
  if not found then
    return;
  end if;
  v_start := public.page_window_start(v_row.period_start, v_row.period_end,
                                      v_row.quota_period, v_row.pages_period_start);
  return query select
    v_start,
    -- A plan bought up mid-window has its pages pro rata until the window
    -- ends (prorated_pages for that window), then the plan's own.
    case when v_row.prorated_window is not null and v_row.prorated_window = v_start
         then v_row.prorated_pages else v_ent.parsed_pages end
      + case when v_ent.page_addons then v_row.page_block_pages else 0 end,
    -- Usage stored at or after the window's start is this window's, so
    -- rewriting the period start within a period never resets it.
    case when v_row.pages_period_start >= v_start then v_row.pages_used else 0 end,
    v_row.credit_pages,
    case
      when v_ent.page_addons and v_row.page_overage_active then
        greatest(v_row.page_overage_max - case
          when v_row.page_overage_period_start >= v_start
            then v_row.page_overage_used else 0 end, 0)
      else 0
    end;
end;
$$;

revoke all on function public.parsed_pages_balance(uuid, uuid) from public, anon, authenticated;
grant execute on function public.parsed_pages_balance(uuid, uuid) to service_role;


-- 4. What the live add-ons give the account (base is 00073). teams.business
-- is the plan's now, written from the subscription's product; page and
-- domain add-ons count while the team is a live Team Business team.
create or replace function public.sync_capacity_account(p_user_id uuid, p_team_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_units         integer;
  v_overage       boolean;
  v_page_units    integer;
  v_page_overage  boolean;
  v_domain_units  integer;
begin
  select coalesce(max(s.units) filter (where s.kind = 'blocks'), 0),
         coalesce(max(s.units) filter (where s.kind = 'page_blocks'), 0),
         coalesce(bool_or(s.kind = 'overage'), false),
         coalesce(bool_or(s.kind = 'page_overage'), false),
         coalesce(max(s.units) filter (where s.kind = 'domain_blocks'), 0)
    into v_units, v_page_units, v_overage, v_page_overage, v_domain_units
    from public.capacity_subscriptions s
   where s.status in ('active', 'canceled')
     and (s.period_end is null or s.period_end > now() - interval '2 days')
     and (s.user_id = p_user_id or s.team_id = p_team_id);

  if p_team_id is not null then
    update public.teams t
       set block_requests = v.blocks,
           overage_active = v.overage,
           page_block_pages = v.page_blocks,
           page_overage_active = v.page_overage,
           extra_domains = v.domains
      from (select case when live then v_units * public.capacity_block_requests() else 0 end as blocks,
                   live and v_overage as overage,
                   case when live and business
                        then v_page_units * public.capacity_page_block_pages() else 0 end as page_blocks,
                   live and business and v_page_overage as page_overage,
                   case when live and business then v_domain_units else 0 end as domains
              from (select subscription_status is not null as live, business
                      from public.teams where id = p_team_id) team) v
     where t.id = p_team_id
       and (t.block_requests, t.overage_active, t.page_block_pages,
            t.page_overage_active, t.extra_domains)
           is distinct from (v.blocks, v.overage, v.page_blocks, v.page_overage, v.domains);
  else
    update public.users u
       set block_requests = v.blocks,
           overage_active = v.overage,
           page_block_pages = v.page_blocks,
           page_overage_active = v.page_overage,
           extra_domains = v.domains
      from (select case when pe.request_addons
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   pe.request_addons and v_overage as overage,
                   case when pe.page_addons
                        then v_page_units * public.capacity_page_block_pages() else 0 end as page_blocks,
                   pe.page_addons and v_page_overage as page_overage,
                   case when pe.custom_domains > 0 then v_domain_units else 0 end as domains
              from public.users u0
              join public.plan_entitlements pe on pe.key = u0.plan
             where u0.id = p_user_id) v
     where u.id = p_user_id
       and (u.block_requests, u.overage_active, u.page_block_pages, u.page_overage_active,
            u.extra_domains)
           is distinct from (v.blocks, v.overage, v.page_blocks, v.page_overage, v.domains);
  end if;
end;
$$;

revoke all on function public.sync_capacity_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sync_capacity_account(uuid, uuid) to service_role;

-- teams.business changes with the plan now, so the add-ons that need it
-- follow at once (the web app also reconciles them with Polar).
create or replace function public.sync_team_business_addons()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  perform public.sync_capacity_account(null, new.id);
  return null;
end;
$$;

revoke execute on function public.sync_team_business_addons() from public, anon, authenticated;

drop trigger if exists teams_sync_business_addons on public.teams;
create trigger teams_sync_business_addons
  after update of business, subscription_status on public.teams
  for each row
  when (old.business is distinct from new.business
        or (old.subscription_status is null) is distinct from (new.subscription_status is null))
  execute function public.sync_team_business_addons();


-- 5. Period resets (base is 00067). Teams on an annual plan renew their
-- quota monthly inside the year, like annual personal plans, and a team set
-- to end ends with its billing period.
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

  -- Annual plans: the quota period moves to the first monthly boundary after
  -- now() in one pass (a job that was down grants one fresh month, not one
  -- per missed month). The billing period is Polar's and stays.
  with renewed_annual as (
    update public.users u
    set
      requests_used = 0,
      period_start = u.period_end + interval '1 month' * m.n,
      period_end = u.period_end + interval '1 month' * (m.n + 1)
    from (
      select x.id,
             (select max(g)
                from generate_series(0, 1200) g
               where x.period_end + interval '1 month' * g <= now()) as n
        from public.users x
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
      period_start = t.period_end + interval '1 month' * m.n,
      period_end = t.period_end + interval '1 month' * (m.n + 1)
    from (
      select x.id,
             (select max(g)
                from generate_series(0, 1200) g
               where x.period_end + interval '1 month' * g <= now()) as n
        from public.teams x
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


-- 6. The add-on kind goes. Ended rows of it are only history.
delete from public.capacity_subscriptions where kind = 'team_business' and status is null;

alter table public.capacity_subscriptions drop constraint if exists capacity_subscriptions_kind_check;
alter table public.capacity_subscriptions
  add constraint capacity_subscriptions_kind_check
  check (kind in ('blocks', 'overage', 'page_blocks', 'page_overage', 'domain_blocks')) not valid;


-- 7. Validate the constraints added NOT VALID above.
alter table public.teams validate constraint teams_billing_interval_check;
alter table public.teams validate constraint teams_pending_plan_check;
alter table public.teams validate constraint teams_prorated_check;
alter table public.capacity_subscriptions validate constraint capacity_subscriptions_kind_check;

notify pgrst, 'reload schema';
