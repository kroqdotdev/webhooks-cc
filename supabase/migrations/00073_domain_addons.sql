-- 00073: extra inbound domains (mailhooks roadmap, phase 5).
--
-- Business includes one custom inbound domain, Team Business one per team;
-- more are a capacity add-on like monthly blocks (00065, 00070): a
-- unit-priced monthly subscription (domain_blocks, one unit per domain)
-- aligned with the plan, and a one-time order at the monthly price for
-- domains added mid-period (domain_increase), after which the subscription
-- renews at the new count. There is no one-time form and no overage. Like
-- page add-ons they count only with Business (custom_domains > 0) or Team
-- Business, and sync_capacity_account() writes them to extra_domains, which
-- inbound_domains_allowed() (00072) adds to the plan's own.
--
-- Re-runnable.

-- 1. Add-on kinds
alter table public.capacity_subscriptions drop constraint if exists capacity_subscriptions_kind_check;
alter table public.capacity_subscriptions
  add constraint capacity_subscriptions_kind_check
  check (kind in (
    'blocks', 'overage', 'page_blocks', 'page_overage', 'team_business', 'domain_blocks'
  )) not valid;

alter table public.capacity_purchases drop constraint if exists capacity_purchases_kind_check;
alter table public.capacity_purchases
  add constraint capacity_purchases_kind_check
  check (kind in (
    'credits', 'block_increase', 'page_credits', 'page_block_increase', 'domain_increase'
  )) not valid;

comment on column public.capacity_purchases.requests is
  'What the purchase granted: requests, pages for page_credits and page_block_increase, domains for domain_increase.';

-- 2. Applying and granting add-ons: as 00070, with the domain kinds.
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
  if p_kind not in (
    'blocks', 'overage', 'page_blocks', 'page_overage', 'team_business', 'domain_blocks'
  ) then
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
  if p_kind not in (
    'credits', 'block_increase', 'page_credits', 'page_block_increase', 'domain_increase'
  ) then
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

  -- Requests, pages for the page kinds, domains for domain_increase.
  v_requests := p_units::bigint * case
    when p_kind in ('page_credits', 'page_block_increase') then public.capacity_page_block_pages()
    when p_kind = 'domain_increase' then 1
    else public.capacity_block_requests()
  end;
  v_blocks_kind := case p_kind
    when 'page_block_increase' then 'page_blocks'
    when 'domain_increase' then 'domain_blocks'
    else 'blocks'
  end;
  v_credits_kind := case
    when p_kind in ('page_credits', 'page_block_increase') then 'page_credits' else 'credits'
  end;

  if p_kind in ('block_increase', 'page_block_increase', 'domain_increase') then
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

  -- Domains have no one-time form: an increase with no paid-up subscription
  -- to raise (it ended while the checkout was open) is recorded as it is,
  -- grants nothing, and is reported for a refund.
  if p_kind = 'domain_increase' then
    insert into public.capacity_purchases (
      polar_order_id, user_id, team_id, kind, units, requests, amount
    ) values (
      p_order_id, p_user_id, p_team_id, p_kind, p_units, v_requests, p_amount
    );
    return jsonb_build_object('status', 'ok', 'kind', p_kind, 'unapplied', true, 'synced', true);
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


-- 3. What the live add-ons give the account: as 00070, plus extra domains
-- with Business (custom_domains > 0) or, for teams, Team Business.
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
  v_domain_units  integer;
begin
  select coalesce(max(s.units) filter (where s.kind = 'blocks'), 0),
         coalesce(max(s.units) filter (where s.kind = 'page_blocks'), 0),
         coalesce(bool_or(s.kind = 'overage'), false),
         coalesce(bool_or(s.kind = 'page_overage'), false),
         coalesce(bool_or(s.kind = 'team_business'), false),
         coalesce(max(s.units) filter (where s.kind = 'domain_blocks'), 0)
    into v_units, v_page_units, v_overage, v_page_overage, v_team_business, v_domain_units
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
           page_overage_active = v.page_overage,
           extra_domains = v.domains
      from (select case when live then v_units * public.capacity_block_requests() else 0 end as blocks,
                   live and v_overage as overage,
                   live and v_team_business as business,
                   case when live and v_team_business
                        then v_page_units * public.capacity_page_block_pages() else 0 end as page_blocks,
                   live and v_team_business and v_page_overage as page_overage,
                   case when live and v_team_business then v_domain_units else 0 end as domains
              from (select subscription_status is not null as live
                      from public.teams where id = p_team_id) team) v
     where t.id = p_team_id
       and (t.block_requests, t.overage_active, t.business, t.page_block_pages,
            t.page_overage_active, t.extra_domains)
           is distinct from (v.blocks, v.overage, v.business, v.page_blocks, v.page_overage, v.domains);
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

-- 4. Grants: service role only, as before.
revoke all on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.sync_capacity_account(uuid, uuid) from public, anon, authenticated;

grant execute on function public.apply_capacity_subscription(
  uuid, uuid, text, text, text, integer, integer, boolean, timestamptz, timestamptz
) to service_role;
grant execute on function public.grant_capacity_purchase(text, uuid, uuid, text, integer, integer)
  to service_role;
grant execute on function public.sync_capacity_account(uuid, uuid) to service_role;

alter table public.capacity_subscriptions validate constraint capacity_subscriptions_kind_check;
alter table public.capacity_purchases validate constraint capacity_purchases_kind_check;
