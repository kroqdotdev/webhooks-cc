-- 00085: refunds the web app issues through Polar, or holds for a person.
--
-- Some Polar charges buy nothing: a second plan or extra-domains
-- subscription that the webhook revokes, an add-on order paid for an account
-- or team that was deleted meanwhile, extra domains paid for with no
-- subscription left to add them to, and a plan or team subscription whose
-- checkout completed after its account or team was deleted. Until now each
-- was only reported ("refund it"). Each is now a row here, and the web app's
-- refund worker (lib/billing/refunds.ts) works through them:
--
--   * target is what to refund: 'order:<id>', or 'subscription:<id>' for
--     that subscription's paid orders. It is unique, so a redelivered
--     webhook records nothing twice.
--   * held rows wait for a person. Every row is held while automatic
--     refunds are off (POLAR_AUTO_REFUNDS), and an automatic one is held
--     when it is above the cap or a subscription has orders older than two
--     days. The worker first records which orders and how much (orders,
--     planned_cents), so a review sees what approving would refund.
--     approve_polar_refund() and dismiss_polar_refund() are the decisions.
--   * pending rows are refunded by the worker: each order's whole
--     refundable amount, after checking Polar for a refund it already made
--     for this row (its id rides in the refund's metadata). Polar refuses to
--     refund more than an order has left, so a retry cannot pay twice.
--
-- Account columns have no foreign keys: a refund for a deleted account must
-- outlive it. Apply with psql in autocommit mode, as AGENTS.md says.
-- Re-runnable.

create table if not exists public.polar_refunds (
  id              uuid primary key default gen_random_uuid(),
  target          text not null unique
                    constraint polar_refunds_target_check check (target ~ '^(order|subscription):.+$'),
  reason          text not null
                    constraint polar_refunds_reason_check check (reason in (
                      'duplicate_plan', 'duplicate_addon', 'deleted_account',
                      'addon_not_applied', 'addon_ended'
                    )),
  user_id         uuid,
  team_id         uuid,
  status          text not null
                    constraint polar_refunds_status_check check (status in (
                      'held', 'pending', 'refunded', 'nothing', 'failed', 'dismissed'
                    )),
  -- Why a row is held: refunds are off ('manual'), above the cap
  -- ('over_cap'), or a subscription with orders older than the window
  -- ('old_orders').
  hold_reason     text
                    constraint polar_refunds_hold_reason_check
                    check (hold_reason in ('manual', 'over_cap', 'old_orders')),
  -- The orders to refund and their refundable amounts in cents, before
  -- tax: [{order_id, net, tax, created_at, billing_reason}].
  orders          jsonb,
  planned_cents   integer,
  refunded_cents  integer not null default 0,
  refund_ids      text[] not null default '{}',
  -- Set when a person approved a held row: the cap and the window no
  -- longer apply to it.
  approved_at     timestamptz,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  -- Polar's error code or our own, never a message that could carry
  -- customer data.
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint polar_refunds_one_account check (num_nonnulls(user_id, team_id) <= 1)
);

-- What the worker claims: pending rows, and held rows not yet prepared.
create index if not exists polar_refunds_due
  on public.polar_refunds (next_attempt_at)
  where status = 'pending' or (status = 'held' and orders is null);

create index if not exists polar_refunds_open
  on public.polar_refunds (created_at)
  where status in ('held', 'failed');

alter table public.polar_refunds enable row level security;
revoke all on table public.polar_refunds from public, anon, authenticated;


-- Leases due rows to one worker; a crash only delays them until the lease
-- runs out.
create or replace function public.claim_polar_refunds(p_limit integer, p_lease_seconds integer)
returns setof public.polar_refunds
language sql
security definer set search_path = ''
as $$
  update public.polar_refunds r
     set lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = r.attempts + 1,
         updated_at = now()
   where r.id in (
     select d.id
       from public.polar_refunds d
      where (d.status = 'pending' or (d.status = 'held' and d.orders is null))
        and d.next_attempt_at <= now()
        and (d.lease_until is null or d.lease_until < now())
      order by d.next_attempt_at
      limit p_limit
      for update skip locked
   )
  returning r.*;
$$;

-- A person's decision on a held (or failed) row. Approving queues it for
-- the worker with a fresh count of attempts; dismissing closes it.
create or replace function public.approve_polar_refund(p_id uuid)
returns boolean
language sql
security definer set search_path = ''
as $$
  with approved as (
    update public.polar_refunds
       set status = 'pending',
           approved_at = now(),
           attempts = 0,
           next_attempt_at = now(),
           lease_until = null,
           last_error = null,
           updated_at = now()
     where id = p_id
       and status in ('held', 'failed')
    returning 1
  )
  select exists (select 1 from approved);
$$;

create or replace function public.dismiss_polar_refund(p_id uuid)
returns boolean
language sql
security definer set search_path = ''
as $$
  with dismissed as (
    update public.polar_refunds
       set status = 'dismissed',
           lease_until = null,
           updated_at = now(),
           finished_at = now()
     where id = p_id
       and status in ('held', 'failed')
    returning 1
  )
  select exists (select 1 from dismissed);
$$;

revoke all on function public.claim_polar_refunds(integer, integer) from public, anon, authenticated;
revoke all on function public.approve_polar_refund(uuid) from public, anon, authenticated;
revoke all on function public.dismiss_polar_refund(uuid) from public, anon, authenticated;
grant execute on function public.claim_polar_refunds(integer, integer) to service_role;
grant execute on function public.approve_polar_refund(uuid) to service_role;
grant execute on function public.dismiss_polar_refund(uuid) to service_role;

notify pgrst, 'reload schema';
