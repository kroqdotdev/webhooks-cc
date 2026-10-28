-- 00065: extra request capacity. A paid account (Pro, or a team pool) can go
-- past its plan's allowance three ways, in this order:
--
--   1. Recurring blocks: a Polar subscription of 25,000-request units whose
--      billing period the web app keeps aligned with the plan's. Its units
--      raise the allowance itself (block_requests), so captures within it
--      stay one conditional update on the account row.
--   2. One-time blocks: credits bought with a one-time order, kept until used
--      (credit_requests). Spent only once the allowance is used up.
--   3. Overage: a metered Polar subscription. Captures past everything else
--      count up to a maximum the customer sets per plan period
--      (overage_max); the web app reports the count to Polar's meter, which
--      bills it at the end of the period.
--
-- requests_used keeps counting the allowance only, so blocks added mid-period
-- are never eaten by credits or overage spent before them.
--
-- capacity_subscriptions mirrors the add-on subscriptions (one live row per
-- account and kind), capacity_purchases records every one-time order once,
-- which is what makes the Polar webhook safe to repeat. Both are service role
-- only. capture_webhook() and check_email_recipient() change together, as
-- always. Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. Account columns, the same on users and teams
alter table public.users
  add column if not exists block_requests integer not null default 0,
  add column if not exists credit_requests bigint not null default 0,
  add column if not exists overage_active boolean not null default false,
  add column if not exists overage_max integer not null default 0,
  add column if not exists overage_used integer not null default 0,
  add column if not exists overage_period_start timestamptz,
  add column if not exists overage_total bigint not null default 0,
  add column if not exists overage_reported bigint not null default 0,
  add column if not exists overage_reporting_to bigint,
  add column if not exists overage_report_lease timestamptz;

alter table public.teams
  add column if not exists block_requests integer not null default 0,
  add column if not exists credit_requests bigint not null default 0,
  add column if not exists overage_active boolean not null default false,
  add column if not exists overage_max integer not null default 0,
  add column if not exists overage_used integer not null default 0,
  add column if not exists overage_period_start timestamptz,
  add column if not exists overage_total bigint not null default 0,
  add column if not exists overage_reported bigint not null default 0,
  add column if not exists overage_reporting_to bigint,
  add column if not exists overage_report_lease timestamptz;

alter table public.users drop constraint if exists users_capacity_check;
alter table public.users
  add constraint users_capacity_check
  check (block_requests >= 0 and credit_requests >= 0 and overage_max >= 0
         and overage_used >= 0 and overage_reported <= overage_total);

alter table public.teams drop constraint if exists teams_capacity_check;
alter table public.teams
  add constraint teams_capacity_check
  check (block_requests >= 0 and credit_requests >= 0 and overage_max >= 0
         and overage_used >= 0 and overage_reported <= overage_total);

-- No index for the overage reporter: one on these counters would make every
-- overage capture a non-HOT update of the users row. The reporter's scan of
-- these small tables every 30 seconds is cheaper.
drop index if exists public.users_overage_unreported;
drop index if exists public.teams_overage_unreported;

-- 2. Add-on subscriptions
create table if not exists public.capacity_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.users(id) on delete cascade,
  team_id               uuid references public.teams(id) on delete cascade,
  kind                  text not null check (kind in ('blocks', 'overage')),
  polar_subscription_id text not null unique,
  -- null once the subscription has ended; an ended row never comes back.
  status                text check (status in ('active', 'canceled', 'past_due')),
  -- Blocks granted for the current period. Polar's own count only moves at
  -- a renewal (increases are bought as one-time orders, decreases scheduled).
  units                 integer not null default 0 check (units >= 0),
  -- The count Polar renews at: its scheduled change, or else its own count,
  -- which after a paid increase is below units until the renewal.
  pending_units         integer check (pending_units is null or pending_units >= 0),
  cancel_at_period_end  boolean not null default false,
  -- Set when the web app cancelled it because the plan is ending, so keeping
  -- the plan keeps the add-on too.
  canceled_with_plan    boolean not null default false,
  period_start          timestamptz,
  period_end            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint capacity_subscriptions_one_account check (num_nonnulls(user_id, team_id) = 1)
);

create unique index if not exists capacity_subscriptions_live_user
  on public.capacity_subscriptions (user_id, kind)
  where status is not null and user_id is not null;
create unique index if not exists capacity_subscriptions_live_team
  on public.capacity_subscriptions (team_id, kind)
  where status is not null and team_id is not null;
create index if not exists capacity_subscriptions_team
  on public.capacity_subscriptions (team_id) where team_id is not null;

alter table public.capacity_subscriptions enable row level security;
revoke all on table public.capacity_subscriptions from public, anon, authenticated;

-- 3. One-time orders: one-time blocks, and blocks added to the recurring
-- subscription for the rest of its period.
create table if not exists public.capacity_purchases (
  id                    uuid primary key default gen_random_uuid(),
  polar_order_id        text not null unique,
  user_id               uuid references public.users(id) on delete cascade,
  team_id               uuid references public.teams(id) on delete cascade,
  kind                  text not null check (kind in ('credits', 'block_increase')),
  units                 integer not null check (units > 0),
  requests              bigint not null check (requests > 0),
  amount                integer,
  -- block_increase: the subscription and the count Polar renews at, set
  -- there once synced_at is.
  polar_subscription_id text,
  target_units          integer,
  synced_at             timestamptz,
  refunded_at           timestamptz,
  created_at            timestamptz not null default now(),
  constraint capacity_purchases_one_account check (num_nonnulls(user_id, team_id) = 1)
);

create index if not exists capacity_purchases_user
  on public.capacity_purchases (user_id, created_at desc) where user_id is not null;
create index if not exists capacity_purchases_team
  on public.capacity_purchases (team_id, created_at desc) where team_id is not null;

alter table public.capacity_purchases enable row level security;
revoke all on table public.capacity_purchases from public, anon, authenticated;

-- 4. Helpers
create or replace function public.capacity_block_requests()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 25000
$$;

-- Spends one request past the allowance: a one-time block first, then
-- overage while the period's maximum allows. Returns 'credit', 'overage' or
-- null. Called by capture_webhook() only after the allowance refused.
create or replace function public.take_extra_request(p_user_id uuid, p_team_id uuid)
returns text
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_team_id is not null then
    update public.teams
       set credit_requests = credit_requests - 1
     where id = p_team_id
       and subscription_status is not null
       and credit_requests > 0;
    if found then
      return 'credit';
    end if;

    update public.teams
       set overage_used = case
             when overage_period_start is not distinct from period_start then overage_used + 1
             else 1
           end,
           overage_period_start = period_start,
           overage_total = overage_total + 1
     where id = p_team_id
       and subscription_status is not null
       and overage_active
       and period_end > now()
       and case
             when overage_period_start is not distinct from period_start then overage_used
             else 0
           end < overage_max;
    if found then
      return 'overage';
    end if;
    return null;
  end if;

  -- One-time blocks outlive the plan they were bought on.
  update public.users
     set credit_requests = credit_requests - 1
   where id = p_user_id
     and credit_requests > 0;
  if found then
    return 'credit';
  end if;

  update public.users
     set overage_used = case
           when overage_period_start is not distinct from period_start then overage_used + 1
           else 1
         end,
         overage_period_start = period_start,
         overage_total = overage_total + 1
   where id = p_user_id
     and plan = 'pro'
     and overage_active
     and period_end > now()
     and case
           when overage_period_start is not distinct from period_start then overage_used
           else 0
         end < overage_max;
  if found then
    return 'overage';
  end if;
  return null;
end;
$$;

-- Read-only twin of take_extra_request(), for check_email_recipient().
create or replace function public.has_extra_request(p_user_id uuid, p_team_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select case
    when p_team_id is not null then exists (
      select 1 from public.teams t
       where t.id = p_team_id
         and t.subscription_status is not null
         and (t.credit_requests > 0
              or (t.overage_active
                  and t.period_end > now()
                  and case
                        when t.overage_period_start is not distinct from t.period_start then t.overage_used
                        else 0
                      end < t.overage_max))
    )
    else exists (
      select 1 from public.users u
       where u.id = p_user_id
         and (u.credit_requests > 0
              or (u.plan = 'pro'
                  and u.overage_active
                  and u.period_end > now()
                  and case
                        when u.overage_period_start is not distinct from u.period_start then u.overage_used
                        else 0
                      end < u.overage_max))
    )
  end
$$;

-- The allowance now includes recurring blocks. Base is 00001; only the
-- limit changes.
create or replace function public.check_and_decrement_quota(
  p_user_id uuid,
  p_count integer default 1
)
returns table(remaining integer, quota_limit integer, period_end_ts timestamptz)
language plpgsql
security definer set search_path = ''
as $$
begin
  return query
  update public.users
  set requests_used = requests_used + p_count
  where id = p_user_id
    and requests_used + p_count <= request_limit + block_requests
  returning
    request_limit + block_requests - requests_used as remaining,
    request_limit + block_requests as quota_limit,
    public.users.period_end as period_end_ts;
end;
$$;

-- Copies the live add-on subscriptions onto the account row, where captures
-- read them. Blocks and overage need the plan: a free account or an inactive
-- team gets neither, whatever Polar still shows. Both pause while a payment
-- is failing (past_due), and a subscription whose period ended over two days
-- ago without a renewal from Polar no longer counts, so a lost webhook cannot
-- keep granting blocks indefinitely.
create or replace function public.sync_capacity_account(p_user_id uuid, p_team_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_units   integer;
  v_overage boolean;
begin
  select coalesce(max(s.units), 0)
    into v_units
    from public.capacity_subscriptions s
   where s.kind = 'blocks'
     and s.status in ('active', 'canceled')
     and (s.period_end is null or s.period_end > now() - interval '2 days')
     and (s.user_id = p_user_id or s.team_id = p_team_id);

  select exists (
    select 1
      from public.capacity_subscriptions s
     where s.kind = 'overage'
       and s.status in ('active', 'canceled')
       and (s.period_end is null or s.period_end > now() - interval '2 days')
       and (s.user_id = p_user_id or s.team_id = p_team_id)
  ) into v_overage;

  if p_team_id is not null then
    update public.teams t
       set block_requests = v.blocks,
           overage_active = v.overage
      from (select case when subscription_status is not null
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   subscription_status is not null and v_overage as overage
              from public.teams where id = p_team_id) v
     where t.id = p_team_id
       and (t.block_requests, t.overage_active) is distinct from (v.blocks, v.overage);
  else
    update public.users u
       set block_requests = v.blocks,
           overage_active = v.overage
      from (select case when plan = 'pro'
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   plan = 'pro' and v_overage as overage
              from public.users where id = p_user_id) v
     where u.id = p_user_id
       and (u.block_requests, u.overage_active) is distinct from (v.blocks, v.overage);
  end if;
end;
$$;

-- Applies an add-on subscription's state as Polar reports it. Returns
-- {status}: ok; duplicate (another live subscription of this kind already
-- holds the account: a second checkout was completed, left for a person);
-- ended (the row has ended and stays so); stale (read before the renewal
-- the row already has); ignored (never seen, already over); mismatch (the
-- subscription belongs to another account or kind); no_account.
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
  if p_kind not in ('blocks', 'overage') then
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

-- Records a paid one-time order once and grants it. kind 'credits' adds
-- one-time blocks; 'block_increase' adds blocks to the live recurring
-- subscription for the rest of its period and returns the count Polar must
-- renew at. An increase whose subscription ended, or is behind on payment,
-- by the time the payment landed is kept as one-time blocks instead. A repeated order answers 'duplicate'
-- with what the first call recorded.
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
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'exactly one of p_user_id and p_team_id' using errcode = '22023';
  end if;
  if p_kind not in ('credits', 'block_increase') then
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

  v_requests := p_units::bigint * public.capacity_block_requests();

  if p_kind = 'block_increase' then
    -- Only a paid-up subscription takes it: blocks on one whose payment is
    -- failing do not count, and it may well end unpaid.
    select * into v_blocks
      from public.capacity_subscriptions s
     where s.kind = 'blocks'
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
        p_order_id, p_user_id, p_team_id, 'block_increase', p_units, v_requests, p_amount,
        v_blocks.polar_subscription_id, v_target
      );

      perform public.sync_capacity_account(p_user_id, p_team_id);
      return jsonb_build_object(
        'status', 'ok',
        'kind', 'block_increase',
        'subscription_id', v_blocks.polar_subscription_id,
        'target_units', v_target,
        'synced', false
      );
    end if;
  end if;

  insert into public.capacity_purchases (
    polar_order_id, user_id, team_id, kind, units, requests, amount
  ) values (
    p_order_id, p_user_id, p_team_id, 'credits', p_units, v_requests, p_amount
  );

  if p_team_id is not null then
    update public.teams set credit_requests = credit_requests + v_requests where id = p_team_id;
  else
    update public.users set credit_requests = credit_requests + v_requests where id = p_user_id;
  end if;

  return jsonb_build_object('status', 'ok', 'kind', 'credits', 'synced', true);
end;
$$;

-- A refunded one-time block order takes back what is left of it. Refunds
-- of blocks added to a subscription are only marked: their renewal count in
-- Polar is for a person to adjust.
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

  return jsonb_build_object('status', 'ok', 'kind', 'block_increase');
end;
$$;

-- 5. Overage reporting. The web app leases accounts whose overage count is
-- ahead of what Polar has, sends the difference as one meter event whose
-- external id is the range, and confirms it. A lease that runs out resends
-- the same range, which Polar drops as a duplicate.
create or replace function public.claim_overage_reports(
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
     where c.overage_total > c.overage_reported
       and c.polar_customer_id is not null
       and (c.overage_report_lease is null or c.overage_report_lease < now())
     limit greatest(p_limit, 0)
  ),
  claimed_users as (
    update public.users u
       set overage_reporting_to = coalesce(u.overage_reporting_to, u.overage_total),
           overage_report_lease = now() + make_interval(secs => p_lease_seconds)
      from candidate_users c
     where u.id = c.id
       and (u.overage_report_lease is null or u.overage_report_lease < now())
    returning 'user'::text, u.id, u.polar_customer_id, u.overage_reported, u.overage_reporting_to
  ),
  candidate_teams as (
    select c.id
      from public.teams c
     where c.overage_total > c.overage_reported
       and c.polar_customer_id is not null
       and (c.overage_report_lease is null or c.overage_report_lease < now())
     limit greatest(p_limit, 0)
  ),
  claimed_teams as (
    update public.teams t
       set overage_reporting_to = coalesce(t.overage_reporting_to, t.overage_total),
           overage_report_lease = now() + make_interval(secs => p_lease_seconds)
      from candidate_teams c
     where t.id = c.id
       and (t.overage_report_lease is null or t.overage_report_lease < now())
    returning 'team'::text, t.id, t.polar_customer_id, t.overage_reported, t.overage_reporting_to
  )
  select * from claimed_users
  union all
  select * from claimed_teams;
end;
$$;

create or replace function public.complete_overage_report(
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
       set overage_reported = p_to_total,
           overage_reporting_to = null,
           overage_report_lease = null
     where id = p_account_id
       and overage_reporting_to = p_to_total;
  else
    update public.users
       set overage_reported = p_to_total,
           overage_reporting_to = null,
           overage_report_lease = null
     where id = p_account_id
       and overage_reporting_to = p_to_total;
  end if;
end;
$$;

-- 6. capture_webhook(): base is 00063. Teams and users bill recurring blocks
-- with the allowance, then take_extra_request() before quota_exceeded.
create or replace function public.capture_webhook(
  p_slug        text,
  p_method      text,
  p_path        text,
  p_headers     jsonb,
  p_body        text,
  p_query_params jsonb,
  p_content_type text,
  p_ip          text,
  p_received_at timestamptz,
  p_body_raw    bytea default null,
  p_kind        text default 'http',
  p_email       jsonb default null,
  -- Message hash, stored on every email row.
  p_dedupe_key  text default null,
  -- True when the MX host answered "try later" for this message before.
  p_retry       boolean default false,
  -- Real size when the stored body is shorter than what was received.
  p_size        integer default null,
  -- The query string exactly as sent, for forwarding as received.
  p_query_raw   text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_endpoint    record;
  v_user        record;
  v_quota       record;
  v_period      record;
  v_retry_after bigint;
  v_size        integer;
  v_mock        jsonb;
  v_slug        text;
  v_request_id  uuid;
  v_team            record;
  v_billing_team_id uuid;
  v_day             date;
  -- The row this capture's quota lands on; returned so the receiver can cap
  -- concurrent captures per account.
  v_billing_key     text;
  v_kind            text;
  v_existing_id     uuid;
  v_destination     record;
  -- How a capture past the allowance was paid for: 'credit' (a one-time
  -- block) or 'overage'; null when it was not.
  v_extra           text;
  v_included        boolean;
  v_team_active     boolean;
begin
  v_slug := p_slug;
  v_kind := coalesce(p_kind, 'http');
  if v_kind not in ('http', 'email') then
    raise exception 'invalid capture kind: %', v_kind using errcode = '22023';
  end if;
  v_day := (coalesce(p_received_at, now()) at time zone 'UTC')::date;

  -- 1. Look up endpoint by slug (now includes signing fields)
  select id, user_id, name, is_ephemeral, expires_at, mock_response, response_rules,
         request_count,
         signing_provider, signing_secret_encrypted, signing_header,
         agent_registration_id
    into v_endpoint
    from public.endpoints
   where slug = v_slug;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 2. Check expiry
  if v_endpoint.expires_at is not null and v_endpoint.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  -- 2b. Email needs an owning account; nothing is billed or counted otherwise.
  if v_kind = 'email' and v_endpoint.user_id is null then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- 2c. Retry protection. Every attempt with a key takes this lock, so two
  -- attempts of one message on one endpoint run one after the other; a retry
  -- then finds the copy an earlier attempt committed and bills nothing.
  if p_dedupe_key is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(v_endpoint.id::text || ':' || p_dedupe_key, 0)
    );
    if coalesce(p_retry, false) then
      select id into v_existing_id
        from public.requests
       where endpoint_id = v_endpoint.id
         and dedupe_key = p_dedupe_key
       order by received_at desc
       limit 1;
      if v_existing_id is not null then
        return jsonb_build_object('status', 'duplicate', 'request_id', v_existing_id);
      end if;
    end if;
  end if;

  -- 3. Quota check (branching by endpoint type)
  if v_endpoint.is_ephemeral and v_endpoint.user_id is null then
    if v_endpoint.agent_registration_id is not null then
      -- Agent sandbox: one unit of the registration's budget, spent only
      -- while the registration is live and unclaimed. A capture the
      -- endpoint cap below then refuses has still spent its unit; the
      -- budget is small and never refunded, so that stays harmless.
      v_billing_key := 'agent:' || v_endpoint.agent_registration_id::text;
      update public.agent_registrations
         set sandbox_requests_used = sandbox_requests_used + 1
       where id = v_endpoint.agent_registration_id
         and claimed_at is null
         and revoked_at is null
         and expires_at > now()
         and sandbox_requests_used < sandbox_request_limit;

      if not found then
        perform public.bump_endpoint_daily_stats(v_endpoint.id, null, null, v_day, 0, 0, 1, 0);
        return jsonb_build_object('status', 'quota_exceeded', 'billing_key', v_billing_key);
      end if;
    else
      v_billing_key := 'endpoint:' || v_endpoint.id::text;
    end if;

    -- Ephemeral endpoint: atomic increment with 25-request cap
    select request_count into v_quota
      from public.check_and_increment_ephemeral(v_endpoint.id);

    if not found then
      perform public.bump_endpoint_daily_stats(v_endpoint.id, null, null, v_day, 0, 0, 1, 0);
      return jsonb_build_object('status', 'quota_exceeded', 'billing_key', v_billing_key);
    end if;

  elsif v_endpoint.user_id is not null then
    -- Team billing: oldest share into a team with an active subscription wins.
    select t.id, t.period_end, t.credit_requests, t.overage_active
      into v_team
      from public.team_endpoints te
      join public.teams t on t.id = te.team_id
     where te.endpoint_id = v_endpoint.id
       and t.subscription_status is not null
     order by te.shared_at asc
     limit 1;

    v_billing_key := case
      when v_team.id is not null then 'team:' || v_team.id::text
      else 'user:' || v_endpoint.user_id::text
    end;

    if v_team.id is not null then
      -- Pooled quota: atomic conditional increment on the single team row.
      -- The status condition re-checks the window between the select above
      -- and this update: a team deactivated in between must not be billed.
      update public.teams
         set requests_used = requests_used + 1
       where id = v_team.id
         and subscription_status is not null
         and requests_used < request_limit + block_requests;

      if found then
        v_billing_team_id := v_team.id;
      else
        -- No row updated: pool exhausted, or the team deactivated since the
        -- select. Only a still-active team may answer quota_exceeded; a
        -- deactivated one falls through to the owner's personal quota below.
        perform 1 from public.teams
         where id = v_team.id
           and subscription_status is not null;
        v_team_active := found;

        -- A still-active team past its pool spends a one-time block, then
        -- overage, before it answers quota_exceeded.
        if v_team_active and (v_team.credit_requests > 0 or v_team.overage_active) then
          v_extra := public.take_extra_request(null, v_team.id);
          if v_extra is not null then
            v_billing_team_id := v_team.id;
          end if;
        end if;

        if v_team_active and v_extra is null then
          v_retry_after := null;
          if v_team.period_end is not null and v_team.period_end > now() then
            v_retry_after := extract(epoch from (v_team.period_end - now()))::bigint * 1000;
          end if;

          perform public.bump_endpoint_daily_stats(
            v_endpoint.id, v_endpoint.user_id, v_team.id, v_day, 0, 0, 1, 0
          );
          return jsonb_build_object(
            'status', 'quota_exceeded',
            'retry_after', v_retry_after,
            'billing_key', v_billing_key
          );
        end if;
      end if;
    end if;

    if v_billing_team_id is null then
      -- Owned endpoint: check user quota
      select id, plan, request_limit, requests_used, period_end, credit_requests, overage_active
        into v_user
        from public.users
       where id = v_endpoint.user_id;

      if not found then
        return jsonb_build_object('status', 'not_found');
      end if;

      -- Free user with expired or unstarted period: start a new one. When
      -- concurrent captures race here, one starts the period and the others
      -- find no row to update once its lock is released; they carry on with
      -- the period it started instead of answering quota_exceeded.
      if v_user.plan = 'free' and (v_user.period_end is null or v_user.period_end <= now()) then
        select remaining, quota_limit, period_end_ts into v_period
          from public.start_free_period(v_endpoint.user_id);

        -- Refresh user row after period reset
        select id, plan, request_limit, requests_used, period_end, credit_requests, overage_active
          into v_user
          from public.users
         where id = v_endpoint.user_id;
      end if;

      -- Atomic quota check + decrement
      select remaining, quota_limit, period_end_ts into v_quota
        from public.check_and_decrement_quota(v_endpoint.user_id, 1);
      v_included := found;

      -- Past the allowance (plan plus recurring blocks): a one-time block,
      -- then overage, before quota_exceeded.
      if not v_included and (v_user.credit_requests > 0 or v_user.overage_active) then
        v_extra := public.take_extra_request(v_endpoint.user_id, null);
      end if;

      if not v_included and v_extra is null then
        -- Quota exceeded
        v_retry_after := null;
        if v_user.period_end is not null and v_user.period_end > now() then
          v_retry_after := extract(epoch from (v_user.period_end - now()))::bigint * 1000;
        end if;

        perform public.bump_endpoint_daily_stats(
          v_endpoint.id, v_endpoint.user_id, null, v_day, 0, 0, 1, 0
        );
        return jsonb_build_object(
          'status', 'quota_exceeded',
          'retry_after', v_retry_after,
          'billing_key', v_billing_key
        );
      end if;

      -- Emails billed to the user this period, for the usage split. The row
      -- is already locked by the decrement above; HTTP captures skip this.
      if v_kind = 'email' then
        update public.users
           set emails_used = case
                 when emails_period_start is not distinct from period_start then emails_used + 1
                 else 1
               end,
               emails_period_start = period_start
         where id = v_endpoint.user_id;
      end if;
    end if;

  end if;
  -- else: owned endpoint with null user_id but not ephemeral: allow through (no quota)

  -- 4. Insert the request (capture generated ID for post-response verification)
  v_size := case
    when p_size is not null and p_size >= 0 then p_size
    else coalesce(octet_length(p_body_raw), octet_length(p_body), 0)
  end;

  insert into public.requests (
    endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key, query_raw
  ) values (
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key,
    nullif(left(p_query_raw, 8192), '')
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    perform public.increment_endpoint_request_count(v_endpoint.id, 1);
  end if;

  -- 5b. Forwarding: queue one delivery per enabled destination that takes
  -- this kind, in the capture's own transaction, so a captured request is
  -- never lost before it is queued; the web app's worker sends them
  -- (claim_email_deliveries) and checks each destination's filter there.
  -- A destination switched off while this runs leaves at most a row the
  -- claim settles.
  for v_destination in
    select d.id
      from public.endpoint_destinations d
     where d.endpoint_id = v_endpoint.id
       and d.enabled
       and case v_kind when 'email' then d.email else d.http end
     order by d.position, d.created_at
  loop
    perform public.queue_destination_delivery(v_request_id, v_endpoint.id, v_destination.id, v_kind);
  end loop;

  perform public.bump_endpoint_daily_stats(
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, v_day,
    1, (v_billing_team_id is not null)::integer, 0, v_size,
    (v_kind = 'email')::integer
  );

  -- 6. Build response
  v_mock := null;
  if v_endpoint.mock_response is not null
     and jsonb_typeof(v_endpoint.mock_response) = 'object'
     and (v_endpoint.mock_response ? 'status')
  then
    v_mock := v_endpoint.mock_response;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'request_id', v_request_id,
    'mock_response', v_mock,
    'response_rules', v_endpoint.response_rules,
    'retry_after', null::bigint,
    -- Notifications are destinations now (00063); the receiver sends none.
    'notification_url', null::text,
    'endpoint_name', v_endpoint.name,
    'signing_provider', v_endpoint.signing_provider,
    'signing_secret_encrypted', encode(v_endpoint.signing_secret_encrypted, 'base64'),
    'signing_header', v_endpoint.signing_header,
    'billing_key', v_billing_key
  );
end;
$$;


revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text
) to service_role;

-- 7. check_email_recipient(): base is 00048, mirroring the above.
create or replace function public.check_email_recipient(p_slug text)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_endpoint record;
  v_team     record;
  v_user     record;
begin
  select id, user_id, expires_at
    into v_endpoint
    from public.endpoints
   where slug = p_slug;

  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_endpoint.expires_at is not null and v_endpoint.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'endpoint_id', v_endpoint.id);
  end if;

  if v_endpoint.user_id is null then
    return jsonb_build_object('status', 'guest', 'endpoint_id', v_endpoint.id);
  end if;

  select t.id, t.requests_used, t.request_limit, t.block_requests
    into v_team
    from public.team_endpoints te
    join public.teams t on t.id = te.team_id
   where te.endpoint_id = v_endpoint.id
     and t.subscription_status is not null
   order by te.shared_at asc
   limit 1;

  if v_team.id is not null then
    if v_team.requests_used >= v_team.request_limit + v_team.block_requests
       and not public.has_extra_request(null, v_team.id) then
      return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
    end if;
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  select plan, request_limit, block_requests, requests_used, period_end
    into v_user
    from public.users
   where id = v_endpoint.user_id;

  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_user.plan = 'free' and (v_user.period_end is null or v_user.period_end <= now()) then
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  if v_user.requests_used + 1 > v_user.request_limit + v_user.block_requests
     and not public.has_extra_request(v_endpoint.user_id, null) then
    return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
  end if;

  return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
end;
$$;

revoke all on function public.check_email_recipient(text) from public, anon, authenticated;
grant execute on function public.check_email_recipient(text) to service_role;

-- 8. Period resets: base is 00034. A plan that ends takes its add-ons along
-- (the web app also ends them in Polar); one-time blocks stay.
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
      polar_subscription_id = null,
      -- Add-ons need a plan; one-time blocks stay.
      block_requests = 0,
      overage_active = false
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

  with deactivated_teams as (
    update public.teams
    set
      subscription_status = null,
      polar_subscription_id = null,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      block_requests = 0,
      overage_active = false
    where subscription_status is not null
      and cancel_at_period_end = true
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select downgraded_count + count(*) into downgraded_count from deactivated_teams;

  -- Renewal advances to the first 30-day boundary after now() in one pass, so
  -- a reset job that was down for more than one interval grants a single fresh
  -- quota window instead of one reset per missed interval on consecutive runs.
  with renewed_teams as (
    update public.teams
    set
      requests_used = 0,
      period_start = period_end + interval '30 days'
        * floor(extract(epoch from (now() - period_end)) / extract(epoch from interval '30 days')),
      period_end = period_end + interval '30 days'
        * (floor(extract(epoch from (now() - period_end)) / extract(epoch from interval '30 days')) + 1)
    where subscription_status is not null
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select renewed_count + count(*) into renewed_count from renewed_teams;

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

revoke all on function public.process_billing_period_resets() from public;
revoke all on function public.process_billing_period_resets() from anon;
revoke all on function public.process_billing_period_resets() from authenticated;
grant execute on function public.process_billing_period_resets() to service_role;

-- 9. Quota emails: base is 00040. Exhausted means past the blocks and out of
-- one-time blocks too (free accounts keep blocks bought while on Pro).
create or replace function public.claim_quota_exhausted_users(p_limit integer default 50)
returns table (
  id uuid,
  email text,
  request_limit integer,
  period_end timestamptz,
  team_billed_endpoints integer
)
language sql
set search_path = ''
as $$
  update public.users u
     set quota_email_claimed_at = now()
   where u.id in (
     select c.id
       from public.users c
      where c.plan = 'free'
        and c.request_limit > 0
        and c.requests_used >= c.request_limit + c.block_requests
        and c.credit_requests = 0
        and c.period_end > now()
        and (c.quota_email_sent_at is null or c.quota_email_sent_at < now() - interval '7 days')
        and (c.quota_email_claimed_at is null or c.quota_email_claimed_at < now() - interval '15 minutes')
        and exists (
          select 1
            from public.endpoints e
           where e.user_id = c.id
             and not public.is_team_billed_endpoint(e.id)
        )
      order by c.period_end
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning u.id, u.email, u.request_limit, u.period_end,
            public.count_team_billed_endpoints(u.id);
$$;

-- 10. Profile signals: also when the add-ons change, or the allowance or a
-- one-time balance runs out or comes back; never per capture.
drop trigger if exists users_broadcast_profile on public.users;
create trigger users_broadcast_profile
  after update on public.users
  for each row
  when (
    old.plan is distinct from new.plan
    or old.request_limit is distinct from new.request_limit
    or old.period_end is distinct from new.period_end
    or old.cancel_at_period_end is distinct from new.cancel_at_period_end
    or old.subscription_status is distinct from new.subscription_status
    or old.name is distinct from new.name
    or old.email is distinct from new.email
    or old.image is distinct from new.image
    or new.requests_used < old.requests_used
    or (old.requests_used >= old.request_limit + old.block_requests)
       is distinct from (new.requests_used >= new.request_limit + new.block_requests)
    or old.block_requests is distinct from new.block_requests
    or (old.credit_requests > 0) is distinct from (new.credit_requests > 0)
    or old.overage_active is distinct from new.overage_active
    or old.overage_max is distinct from new.overage_max
    or (old.overage_used >= old.overage_max) is distinct from (new.overage_used >= new.overage_max)
  )
  execute function public.broadcast_profile_changed();

-- 11. Service role only.
revoke all on function public.capacity_block_requests() from public, anon, authenticated;
revoke all on function public.take_extra_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.has_extra_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.check_and_decrement_quota(uuid, integer) from public, anon, authenticated;
revoke all on function public.sync_capacity_account(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.refund_capacity_purchase(text) from public, anon, authenticated;
revoke all on function public.claim_overage_reports(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_overage_report(text, uuid, bigint) from public, anon, authenticated;

grant execute on function public.capacity_block_requests() to service_role;
grant execute on function public.take_extra_request(uuid, uuid) to service_role;
grant execute on function public.has_extra_request(uuid, uuid) to service_role;
grant execute on function public.check_and_decrement_quota(uuid, integer) to service_role;
grant execute on function public.sync_capacity_account(uuid, uuid) to service_role;
grant execute on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) to service_role;
grant execute on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  to service_role;
grant execute on function public.refund_capacity_purchase(text) to service_role;
grant execute on function public.claim_overage_reports(integer, integer) to service_role;
grant execute on function public.complete_overage_report(text, uuid, bigint) to service_role;

commit;

notify pgrst, 'reload schema';
