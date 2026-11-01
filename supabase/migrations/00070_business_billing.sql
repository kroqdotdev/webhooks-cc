-- 00070: Business billing.
--
-- The business plan itself needs no schema (plan_entitlements has had its
-- row since 00067; the web app writes plan, billing_interval and
-- billing_period_end from Polar). This migration adds what it buys beyond
-- the plan:
--
--   1. Parsed-page add-ons, the same three ways as extra requests (00065):
--      one-time page blocks (page_credits), monthly page blocks
--      (page_blocks, raised mid-period by page_block_increase) and page
--      overage (page_overage), 1,000 pages a block. They count only for
--      accounts whose entitlements have page_addons (Business, Team
--      Business).
--   2. The Team Business add-on, a subscription on the team's customer
--      (team_business): sync_capacity_account() sets teams.business while
--      it and the team's plan are live, and it ends with the plan like the
--      other add-ons.
--   3. A team's request_limit computed from its entitlements on every
--      change of seats or business: seats x the per-seat requests, plus the
--      Team Business pool.
--   4. The page overage reporter's claim and completion, as for requests.
--
-- Apply with psql in autocommit mode, as AGENTS.md says.

-- 0. A plan bought up mid-period (Pro to Business) is charged by Polar for
-- the rest of the period only ("invoice" proration), so for that period the
-- account gets the new plan's extra pages in proportion: prorated_pages
-- stands for the plan's pages in the window that starts at
-- prorated_window. Its requests are set the same way on request_limit by
-- the web app, which knows the period's bounds; both go back to the plan's
-- own at the renewal.
alter table public.users
  add column if not exists prorated_pages integer,
  add column if not exists prorated_window timestamptz,
  -- A plan change Polar applies at the renewal (pending_update), shown on
  -- the plan page until then.
  add column if not exists pending_plan text,
  add column if not exists pending_interval text;

alter table public.users drop constraint if exists users_pending_plan_check;
-- Added unchecked and validated after, so the scan of users does not hold
-- the table's exclusive lock.
alter table public.users
  add constraint users_pending_plan_check
  check (
    (pending_plan is null and pending_interval is null)
    or (pending_plan is not null and pending_interval is not null
        and pending_plan in ('pro', 'business') and pending_interval in ('month', 'year'))
  ) not valid;
alter table public.users validate constraint users_pending_plan_check;

-- The pro rata allowance belongs to one window: whatever moves the period
-- on (the renewal webhook, or the fallback in process_billing_period_resets
-- before it arrives) gives the plan's own requests back with it.
create or replace function public.end_plan_proration()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.prorated_window is not null
     and new.prorated_window is distinct from new.period_start then
    new.request_limit := coalesce(
      (select pe.request_limit from public.plan_entitlements pe where pe.key = new.plan),
      new.request_limit
    );
    new.prorated_pages := null;
    new.prorated_window := null;
  end if;
  -- A plan that lapsed has no change waiting.
  if new.plan = 'free' then
    new.pending_plan := null;
    new.pending_interval := null;
  end if;
  return new;
end;
$$;

revoke all on function public.end_plan_proration() from public, anon, authenticated;

drop trigger if exists users_end_plan_proration on public.users;
create trigger users_end_plan_proration
  before update of period_start on public.users
  for each row
  when (old.period_start is distinct from new.period_start)
  execute function public.end_plan_proration();

-- 1. Add-on kinds
alter table public.capacity_subscriptions drop constraint if exists capacity_subscriptions_kind_check;
alter table public.capacity_subscriptions
  add constraint capacity_subscriptions_kind_check
  check (kind in ('blocks', 'overage', 'page_blocks', 'page_overage', 'team_business')) not valid;

alter table public.capacity_purchases drop constraint if exists capacity_purchases_kind_check;
alter table public.capacity_purchases
  add constraint capacity_purchases_kind_check
  check (kind in ('credits', 'block_increase', 'page_credits', 'page_block_increase')) not valid;

comment on column public.capacity_purchases.requests is
  'What the purchase granted: requests, or pages for page_credits and page_block_increase.';

create or replace function public.capacity_page_block_pages()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 1000
$$;

-- 2. Applying and granting add-ons: as 00065, for every kind.
create or replace function public.apply_capacity_subscription(
  p_user_id              uuid,
  p_team_id              uuid,
  p_kind                 text,
  p_subscription_id      text,
  p_status               text,
  p_units                integer,
  p_pending_units        integer,
  p_cancel_at_period_end boolean,
  p_period_start         timestamptz,
  p_period_end           timestamptz
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row   public.capacity_subscriptions;
  v_units integer;
  v_stale boolean;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'exactly one of p_user_id and p_team_id' using errcode = '22023';
  end if;
  if p_kind not in ('blocks', 'overage', 'page_blocks', 'page_overage', 'team_business') then
    raise exception 'invalid kind: %', p_kind using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('active', 'canceled', 'past_due') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  -- The account row lock orders this against purchases for the account.
  if p_team_id is not null then
    perform 1 from public.teams where id = p_team_id for update;
  else
    perform 1 from public.users where id = p_user_id for update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;

  select * into v_row
    from public.capacity_subscriptions
   where polar_subscription_id = p_subscription_id
   for update;

  if not found then
    if p_status is null then
      return jsonb_build_object('status', 'ignored');
    end if;

    perform 1
       from public.capacity_subscriptions s
      where s.kind = p_kind
        and s.status is not null
        and (s.user_id = p_user_id or s.team_id = p_team_id);
    if found then
      return jsonb_build_object('status', 'duplicate');
    end if;

    insert into public.capacity_subscriptions (
      user_id, team_id, kind, polar_subscription_id, status, units, pending_units,
      cancel_at_period_end, period_start, period_end
    ) values (
      p_user_id, p_team_id, p_kind, p_subscription_id, p_status, greatest(coalesce(p_units, 0), 0),
      p_pending_units, coalesce(p_cancel_at_period_end, false), p_period_start, p_period_end
    );
  else
    if v_row.user_id is distinct from p_user_id
       or v_row.team_id is distinct from p_team_id
       or v_row.kind <> p_kind then
      return jsonb_build_object('status', 'mismatch');
    end if;
    if v_row.status is null then
      return jsonb_build_object('status', 'ended');
    end if;

    if p_status is null then
      update public.capacity_subscriptions
         set status = null,
             units = 0,
             pending_units = null,
             cancel_at_period_end = false,
             canceled_with_plan = false,
             updated_at = now()
       where id = v_row.id;
    else
      -- A period start older than the stored one is an out-of-order delivery
      -- read before a renewal: nothing in it is current.
      v_stale := p_period_start is not null and v_row.period_start is not null
                 and p_period_start < v_row.period_start;
      if v_stale then
        return jsonb_build_object('status', 'stale');
      end if;
      -- Within a period the count only grows (an increase is paid for and
      -- granted at once, a decrease waits for the renewal); a renewal takes
      -- Polar's count, which by then includes both.
      v_units := case
        when p_period_start is null then v_row.units
        when v_row.period_start is not null
             and p_period_start > v_row.period_start then greatest(coalesce(p_units, 0), 0)
        else greatest(v_row.units, coalesce(p_units, 0))
      end;

      update public.capacity_subscriptions
         set status = p_status,
             units = v_units,
             pending_units = p_pending_units,
             cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
             canceled_with_plan = coalesce(p_cancel_at_period_end, false) and canceled_with_plan,
             period_start = coalesce(p_period_start, v_row.period_start),
             period_end = coalesce(p_period_end, v_row.period_end),
             updated_at = now()
       where id = v_row.id;
    end if;
  end if;

  perform public.sync_capacity_account(p_user_id, p_team_id);
  return jsonb_build_object('status', 'ok');
end;
$$;


create or replace function public.grant_capacity_purchase(
  p_order_id text,
  p_user_id  uuid,
  p_team_id  uuid,
  p_kind     text,
  p_units    integer,
  p_amount   integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_purchase public.capacity_purchases;
  v_blocks   public.capacity_subscriptions;
  v_requests bigint;
  v_target   integer;
  v_blocks_kind  text;
  v_credits_kind text;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'exactly one of p_user_id and p_team_id' using errcode = '22023';
  end if;
  if p_kind not in ('credits', 'block_increase', 'page_credits', 'page_block_increase') then
    raise exception 'invalid kind: %', p_kind using errcode = '22023';
  end if;
  if p_units is null or p_units < 1 then
    raise exception 'units must be positive' using errcode = '22023';
  end if;

  if p_team_id is not null then
    perform 1 from public.teams where id = p_team_id for update;
  else
    perform 1 from public.users where id = p_user_id for update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;

  select * into v_purchase
    from public.capacity_purchases
   where polar_order_id = p_order_id;
  if found then
    return jsonb_build_object(
      'status', 'duplicate',
      'kind', v_purchase.kind,
      'subscription_id', v_purchase.polar_subscription_id,
      'target_units', v_purchase.target_units,
      'synced', v_purchase.synced_at is not null
    );
  end if;

  -- Requests, or pages for the page kinds.
  v_requests := p_units::bigint * case
    when p_kind in ('page_credits', 'page_block_increase') then public.capacity_page_block_pages()
    else public.capacity_block_requests()
  end;
  v_blocks_kind := case when p_kind = 'page_block_increase' then 'page_blocks' else 'blocks' end;
  v_credits_kind := case
    when p_kind in ('page_credits', 'page_block_increase') then 'page_credits' else 'credits'
  end;

  if p_kind in ('block_increase', 'page_block_increase') then
    -- Only a paid-up subscription takes it: blocks on one whose payment is
    -- failing do not count, and it may well end unpaid.
    select * into v_blocks
      from public.capacity_subscriptions s
     where s.kind = v_blocks_kind
       and s.status in ('active', 'canceled')
       and (s.user_id = p_user_id or s.team_id = p_team_id)
     for update;

    if found then
      update public.capacity_subscriptions
         set units = units + p_units,
             updated_at = now()
       where id = v_blocks.id
      returning units into v_target;

      insert into public.capacity_purchases (
        polar_order_id, user_id, team_id, kind, units, requests, amount,
        polar_subscription_id, target_units
      ) values (
        p_order_id, p_user_id, p_team_id, p_kind, p_units, v_requests, p_amount,
        v_blocks.polar_subscription_id, v_target
      );

      perform public.sync_capacity_account(p_user_id, p_team_id);
      return jsonb_build_object(
        'status', 'ok',
        'kind', p_kind,
        'subscription_id', v_blocks.polar_subscription_id,
        'target_units', v_target,
        'synced', false
      );
    end if;
  end if;

  insert into public.capacity_purchases (
    polar_order_id, user_id, team_id, kind, units, requests, amount
  ) values (
    p_order_id, p_user_id, p_team_id, v_credits_kind, p_units, v_requests, p_amount
  );

  if v_credits_kind = 'page_credits' then
    if p_team_id is not null then
      update public.teams set credit_pages = credit_pages + v_requests where id = p_team_id;
    else
      update public.users set credit_pages = credit_pages + v_requests where id = p_user_id;
    end if;
  elsif p_team_id is not null then
    update public.teams set credit_requests = credit_requests + v_requests where id = p_team_id;
  else
    update public.users set credit_requests = credit_requests + v_requests where id = p_user_id;
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_credits_kind, 'synced', true);
end;
$$;


create or replace function public.refund_capacity_purchase(p_order_id text)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_purchase public.capacity_purchases;
begin
  select * into v_purchase
    from public.capacity_purchases
   where polar_order_id = p_order_id
   for update;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if v_purchase.refunded_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  update public.capacity_purchases set refunded_at = now() where id = v_purchase.id;

  if v_purchase.kind = 'page_credits' then
    if v_purchase.team_id is not null then
      update public.teams
         set credit_pages = greatest(credit_pages - v_purchase.requests, 0)
       where id = v_purchase.team_id;
    else
      update public.users
         set credit_pages = greatest(credit_pages - v_purchase.requests, 0)
       where id = v_purchase.user_id;
    end if;
    return jsonb_build_object('status', 'ok', 'kind', 'page_credits');
  end if;

  if v_purchase.kind = 'credits' then
    if v_purchase.team_id is not null then
      update public.teams
         set credit_requests = greatest(credit_requests - v_purchase.requests, 0)
       where id = v_purchase.team_id;
    else
      update public.users
         set credit_requests = greatest(credit_requests - v_purchase.requests, 0)
       where id = v_purchase.user_id;
    end if;
    return jsonb_build_object('status', 'ok', 'kind', 'credits');
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_purchase.kind);
end;
$$;


-- 3. What the live add-ons give the account. Teams: Team Business while the
-- team's plan is live; page blocks and overage only with Team Business.
-- Users: page blocks and overage only with page_addons (Business).
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
  v_team_business boolean;
begin
  select coalesce(max(s.units) filter (where s.kind = 'blocks'), 0),
         coalesce(max(s.units) filter (where s.kind = 'page_blocks'), 0),
         coalesce(bool_or(s.kind = 'overage'), false),
         coalesce(bool_or(s.kind = 'page_overage'), false),
         coalesce(bool_or(s.kind = 'team_business'), false)
    into v_units, v_page_units, v_overage, v_page_overage, v_team_business
    from public.capacity_subscriptions s
   where s.status in ('active', 'canceled')
     and (s.period_end is null or s.period_end > now() - interval '2 days')
     and (s.user_id = p_user_id or s.team_id = p_team_id);

  if p_team_id is not null then
    update public.teams t
       set block_requests = v.blocks,
           overage_active = v.overage,
           business = v.business,
           page_block_pages = v.page_blocks,
           page_overage_active = v.page_overage
      from (select case when live then v_units * public.capacity_block_requests() else 0 end as blocks,
                   live and v_overage as overage,
                   live and v_team_business as business,
                   case when live and v_team_business
                        then v_page_units * public.capacity_page_block_pages() else 0 end as page_blocks,
                   live and v_team_business and v_page_overage as page_overage
              from (select subscription_status is not null as live
                      from public.teams where id = p_team_id) team) v
     where t.id = p_team_id
       and (t.block_requests, t.overage_active, t.business, t.page_block_pages, t.page_overage_active)
           is distinct from (v.blocks, v.overage, v.business, v.page_blocks, v.page_overage);
  else
    update public.users u
       set block_requests = v.blocks,
           overage_active = v.overage,
           page_block_pages = v.page_blocks,
           page_overage_active = v.page_overage
      from (select case when pe.request_addons
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   pe.request_addons and v_overage as overage,
                   case when pe.page_addons
                        then v_page_units * public.capacity_page_block_pages() else 0 end as page_blocks,
                   pe.page_addons and v_page_overage as page_overage
              from public.users u0
              join public.plan_entitlements pe on pe.key = u0.plan
             where u0.id = p_user_id) v
     where u.id = p_user_id
       and (u.block_requests, u.overage_active, u.page_block_pages, u.page_overage_active)
           is distinct from (v.blocks, v.overage, v.page_blocks, v.page_overage);
  end if;
end;
$$;

-- 4. A team's request limit from its entitlements: seats x the per-seat
-- requests, plus the Team Business pool. Whatever writes seats, business or
-- request_limit (the seat webhooks, update_team_seats(), the add-on sync)
-- gets the same number.
create or replace function public.team_request_limit()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_per_seat integer;
  v_pool     integer;
begin
  select pe.request_limit, pe.pool_requests into v_per_seat, v_pool
    from public.plan_entitlements pe
   where pe.key = case when new.business then 'team_business' else 'team' end;
  if found then
    new.request_limit := new.seats * v_per_seat + v_pool;
  end if;
  return new;
end;
$$;

revoke execute on function public.team_request_limit() from public, anon, authenticated;

drop trigger if exists teams_request_limit on public.teams;
create trigger teams_request_limit
  before insert or update of seats, business, request_limit on public.teams
  for each row
  execute function public.team_request_limit();

-- 4b. The pages an account has, with the pro rata pages of a plan bought up
-- mid-window (base is 00069).
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
           null::integer as prorated_pages, null::timestamptz as prorated_window
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

-- 5. Page overage reporting, as for requests (the reporter's event is
-- page.overage with the pages in its metadata).
create or replace function public.claim_page_overage_reports(
  p_limit integer default 50,
  p_lease_seconds integer default 120
)
returns table (
  account_kind      text,
  account_id        uuid,
  polar_customer_id text,
  from_total        bigint,
  to_total          bigint
)
language plpgsql
security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  -- The candidates are read without locks and the update waits for each row:
  -- an account in overage is the one whose row captures hold most of the
  -- time, so skipping locked rows would keep skipping exactly it. The lease
  -- condition, re-checked under the lock, keeps two reporters apart.
  return query
  with candidate_users as (
    select c.id
      from public.users c
     where c.page_overage_total > c.page_overage_reported
       and c.polar_customer_id is not null
       and (c.page_overage_report_lease is null or c.page_overage_report_lease < now())
     limit greatest(p_limit, 0)
  ),
  claimed_users as (
    update public.users u
       set page_overage_reporting_to = coalesce(u.page_overage_reporting_to, u.page_overage_total),
           page_overage_report_lease = now() + make_interval(secs => p_lease_seconds)
      from candidate_users c
     where u.id = c.id
       and (u.page_overage_report_lease is null or u.page_overage_report_lease < now())
    returning 'user'::text, u.id, u.polar_customer_id, u.page_overage_reported, u.page_overage_reporting_to
  ),
  candidate_teams as (
    select c.id
      from public.teams c
     where c.page_overage_total > c.page_overage_reported
       and c.polar_customer_id is not null
       and (c.page_overage_report_lease is null or c.page_overage_report_lease < now())
     limit greatest(p_limit, 0)
  ),
  claimed_teams as (
    update public.teams t
       set page_overage_reporting_to = coalesce(t.page_overage_reporting_to, t.page_overage_total),
           page_overage_report_lease = now() + make_interval(secs => p_lease_seconds)
      from candidate_teams c
     where t.id = c.id
       and (t.page_overage_report_lease is null or t.page_overage_report_lease < now())
    returning 'team'::text, t.id, t.polar_customer_id, t.page_overage_reported, t.page_overage_reporting_to
  )
  select * from claimed_users
  union all
  select * from claimed_teams;
end;
$$;


create or replace function public.complete_page_overage_report(
  p_account_kind text,
  p_account_id   uuid,
  p_to_total     bigint
)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_account_kind = 'team' then
    update public.teams
       set page_overage_reported = p_to_total,
           page_overage_reporting_to = null,
           page_overage_report_lease = null
     where id = p_account_id
       and page_overage_reporting_to = p_to_total;
  else
    update public.users
       set page_overage_reported = p_to_total,
           page_overage_reporting_to = null,
           page_overage_report_lease = null
     where id = p_account_id
       and page_overage_reporting_to = p_to_total;
  end if;
end;
$$;


-- 6. Grants: service role only.
revoke all on function public.capacity_page_block_pages() from public, anon, authenticated;
revoke all on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.refund_capacity_purchase(text) from public, anon, authenticated;
revoke all on function public.sync_capacity_account(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_page_overage_reports(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_page_overage_report(text, uuid, bigint) from public, anon, authenticated;

grant execute on function public.capacity_page_block_pages() to service_role;
grant execute on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) to service_role;
grant execute on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  to service_role;
grant execute on function public.refund_capacity_purchase(text) to service_role;
grant execute on function public.sync_capacity_account(uuid, uuid) to service_role;
grant execute on function public.claim_page_overage_reports(integer, integer) to service_role;
grant execute on function public.complete_page_overage_report(text, uuid, bigint) to service_role;

alter table public.capacity_subscriptions validate constraint capacity_subscriptions_kind_check;
alter table public.capacity_purchases validate constraint capacity_purchases_kind_check;

notify pgrst, 'reload schema';
