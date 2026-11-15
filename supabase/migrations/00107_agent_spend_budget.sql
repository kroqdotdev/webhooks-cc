-- An agent spend budget per billing account (a person's own plan, or a
-- team's): the cents before tax an API key or agent token of the owner may
-- have charged to the saved card without the owner approving each change
-- (lib/billing/agent-budget.ts), counted over 30 days. 0 is off, the
-- default; $500 is the most. Only changes Polar charges at once run on it
-- (Pro to Business monthly, Teams to Team Business, more seats); everything
-- else stays a billing.change approval. A change counts at what it charges
-- now (before account credit) plus how much it raises the next renewal:
-- always on a monthly subscription, and on an annual one when its renewal
-- is at most 31 days away, so the budget bounds both. On an annual plan
-- whose renewal is further, it counts at the larger of the two (a seat
-- counts at the full year's price), and the budget then bounds less than
-- everything that period charges; a seat added more than 60 days before an
-- annual renewal is not bounded at that renewal at all. Renewals after that
-- keep the new price.
--
-- Each spend is a row of agent_budget_spends, counted until counts_until
-- unless it was given back ('returned'): 30 days from when it was taken,
-- or, when the renewal it was priced on is at most 60 days away, 30 days
-- from that renewal, so the rise charged there is inside a window (whether
-- its rise was counted on top, or only as the larger of the two); a charge Polar took later (a payment the bank had the
-- cardholder confirm) counts 30 days from when it was paid. A plan change
-- or seats removed later do not shorten it: the owner can raise the budget.
-- Every sum here uses that one rule (agent_budget_counted_cents). One whose
-- outcome is not known stays counted unless Polar shows it made. A spend
-- that certainly reached no charge (refused before Polar, or by Polar
-- before charging) is given back at once; one whose outcome was ever not
-- known (unsettled_at) is never given back by a later run. The take is
-- serialised on the billing account's row and is one conditional
-- statement, keyed by an idempotency key per change, so a retry of the same
-- change never takes twice. The web app makes the change holding the
-- account's billing change lease (billing_change_locks, migration 00106),
-- as an approved change does, so one change per account runs at a time.

-- 1. The budgets. Adding a column with a constant default is metadata only;
-- the checks are added NOT VALID and validated without blocking writes.
alter table public.users
  add column if not exists agent_budget_cents integer not null default 0;
alter table public.teams
  add column if not exists agent_budget_cents integer not null default 0;

alter table public.users drop constraint if exists users_agent_budget_range,
  add constraint users_agent_budget_range
    check (agent_budget_cents between 0 and 50000) not valid;
alter table public.teams drop constraint if exists teams_agent_budget_range,
  add constraint teams_agent_budget_range
    check (agent_budget_cents between 0 and 50000) not valid;
alter table public.users validate constraint users_agent_budget_range;
alter table public.teams validate constraint teams_agent_budget_range;

-- 2. The ledger.
create table if not exists public.agent_budget_spends (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.users(id) on delete cascade,
  team_id               uuid references public.teams(id) on delete cascade,
  idempotency_key       text not null check (char_length(idempotency_key) between 1 and 200),
  -- Who spent it: the API key (agent tokens are api_keys rows too) and, for
  -- an agent token, its registration. No foreign keys: a revoked key's
  -- spends keep counting.
  key_id                uuid,
  agent_registration_id uuid,
  -- The change (lib/billing/change.ts BillingChange) and its sentence.
  change                jsonb not null check (jsonb_typeof(change) = 'object'),
  description           text not null check (char_length(description) <= 500),
  -- What the change counted at when taken (its charge now, before account
  -- credit, plus the rise of the next renewal; on an annual subscription
  -- the larger of the two); amount_cents is what counts, raised when the
  -- order's before-tax amount (plus the rise, on a monthly subscription)
  -- or a resend's quote comes out higher, never lowered.
  quoted_cents          integer not null check (quoted_cents >= 0),
  amount_cents          integer not null check (amount_cents >= 0),
  -- The billing period the change was priced on (Polar's current_period_end):
  -- a retry in another period is never sent again.
  period_end            timestamptz,
  -- What the owner's email says ({chargeCents, approximate, renewalCents,
  -- renewalRiseCents, annual}), kept so a webhook or the poller can send it.
  facts                 jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  -- running: the change is being made; applied: Polar made it; unsettled:
  -- the answer was lost (a timeout), kept taken until a webhook or a retry
  -- settles it; returned: Polar refused it, given back.
  status                text not null default 'running'
                          check (status in ('running', 'applied', 'unsettled', 'returned')),
  -- What Polar's subscription shows once the change is made
  -- ({"seats": n} or {"productId": "..."}), to settle and to check before a retry.
  polar_subscription_id text,
  target                jsonb not null default '{}'::jsonb check (jsonb_typeof(target) = 'object'),
  polar_order_id        text,
  -- What the asker was answered, kept for a retry of the same key.
  outcome               jsonb,
  -- The owner's emails: emailed_at once told the change was made,
  -- unknown_emailed_at once told it may have been (an outcome not known);
  -- email_claimed_at is the claim of whoever is sending one (five minutes),
  -- so the request, a webhook and the poller never send it twice. A send
  -- that fails waits until email_next_at, later after each try
  -- (email_attempts, at most 30 tries); one with nobody to send it to (no
  -- owner, no address), or still unsent 7 days after its status last moved
  -- (status_changed_at), is email_undeliverable and leaves the queue until
  -- an order, a webhook or a run makes it.
  emailed_at            timestamptz,
  unknown_emailed_at    timestamptz,
  email_claimed_at      timestamptz,
  email_attempts        integer not null default 0 check (email_attempts >= 0),
  email_next_at         timestamptz not null default now(),
  email_undeliverable   boolean not null default false,
  taken_at              timestamptz not null default now(),
  -- Until when the spend counts (see the header): set by the take, moved
  -- later by a resend or by an order paid later, never earlier.
  counts_until          timestamptz not null default now() + interval '30 days',
  -- When its outcome was first not known (unsettled, or a run that died):
  -- from then on no run gives it back, since the first try may have charged.
  -- Seats above its target count as made only within 15 minutes of it.
  unsettled_at          timestamptz,
  -- When its status last moved, or it was last sent to Polar: the take, a
  -- resend, a settle, a webhook or an order that made it. A retry that only
  -- looks (claim_agent_budget_retry with no amount) moves it not, nor
  -- updated_at, so looking never stretches the order match (10 minutes) or
  -- the email's 7 days.
  status_changed_at     timestamptz not null default now(),
  -- Held by a retry that only looks (five minutes), so one request at a
  -- time looks; cleared by the settle that follows.
  retry_claimed_at      timestamptz,
  -- When a subscription event showed its target while it was running, so
  -- its run, if it ends without an answer, settles it as made.
  target_seen_at        timestamptz,
  -- When it was given back; a paid order for its target within a day
  -- brings it back (raise_agent_budget_from_order).
  returned_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint agent_budget_spends_one_account check (num_nonnulls(user_id, team_id) = 1)
);

-- Columns added after the first drafts of this file, which dev databases
-- applied: added here when the table above already existed without them.
alter table public.agent_budget_spends
  add column if not exists period_end          timestamptz,
  add column if not exists facts               jsonb not null default '{}'::jsonb,
  add column if not exists emailed_at          timestamptz,
  add column if not exists unknown_emailed_at  timestamptz,
  add column if not exists email_claimed_at    timestamptz,
  add column if not exists email_attempts      integer not null default 0,
  add column if not exists email_next_at       timestamptz not null default now(),
  add column if not exists email_undeliverable boolean not null default false,
  add column if not exists counts_until        timestamptz not null default now() + interval '30 days',
  add column if not exists unsettled_at        timestamptz,
  add column if not exists status_changed_at   timestamptz not null default now(),
  add column if not exists retry_claimed_at    timestamptz,
  add column if not exists target_seen_at      timestamptz,
  add column if not exists returned_at         timestamptz;

-- One live spend per key and account: a spend given back keeps its row as
-- history, and the same key may take a new one.
drop index if exists public.agent_budget_spends_user_key;
drop index if exists public.agent_budget_spends_team_key;
create unique index if not exists agent_budget_spends_user_live_key
  on public.agent_budget_spends (user_id, idempotency_key)
  where user_id is not null and status <> 'returned';
create unique index if not exists agent_budget_spends_team_live_key
  on public.agent_budget_spends (team_id, idempotency_key)
  where team_id is not null and status <> 'returned';
create index if not exists agent_budget_spends_user_time
  on public.agent_budget_spends (user_id, taken_at desc) where user_id is not null;
create index if not exists agent_budget_spends_team_time
  on public.agent_budget_spends (team_id, taken_at desc) where team_id is not null;
create index if not exists agent_budget_spends_subscription
  on public.agent_budget_spends (polar_subscription_id, taken_at desc)
  where polar_subscription_id is not null;
-- An order's spend, looked up by raise_agent_budget_from_order on every paid order.
create index if not exists agent_budget_spends_order
  on public.agent_budget_spends (polar_order_id)
  where polar_order_id is not null;
-- The email poller's queue: spends the owner has not been told of yet, by
-- when each may be tried next.
create index if not exists agent_budget_spends_unemailed
  on public.agent_budget_spends (email_next_at)
  where emailed_at is null and status <> 'returned' and not email_undeliverable;

alter table public.agent_budget_spends enable row level security;
revoke all on table public.agent_budget_spends from public, anon, authenticated;

-- Reductions (fewer seats, fewer monthly blocks) a key made while the
-- budget was on. Nothing is counted; each is recorded so its notice can be
-- sent again when a send fails, and so notices are batched: at most one
-- per account an hour, carrying every reduction made since the last.
create table if not exists public.agent_budget_reductions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.users(id) on delete cascade,
  team_id             uuid references public.teams(id) on delete cascade,
  -- The key that made it, and the agent registration for an agent token;
  -- no foreign keys, as for spends.
  key_id              uuid,
  agent_registration_id uuid,
  description        text not null check (char_length(description) <= 500),
  renewal_cents       integer check (renewal_cents is null or renewal_cents >= 0),
  made_at             timestamptz not null default now(),
  -- The notice: emailed_at once sent; email_claim names the send that
  -- holds it (five minutes), so two senders never batch the same rows.
  emailed_at          timestamptz,
  email_claim         uuid,
  email_claimed_at    timestamptz,
  email_attempts      integer not null default 0 check (email_attempts >= 0),
  email_next_at       timestamptz not null default now(),
  email_undeliverable boolean not null default false,
  constraint agent_budget_reductions_one_account check (num_nonnulls(user_id, team_id) = 1)
);

alter table public.agent_budget_reductions
  add column if not exists agent_registration_id uuid;

create index if not exists agent_budget_reductions_user_time
  on public.agent_budget_reductions (user_id, made_at desc) where user_id is not null;
create index if not exists agent_budget_reductions_team_time
  on public.agent_budget_reductions (team_id, made_at desc) where team_id is not null;
create index if not exists agent_budget_reductions_unemailed
  on public.agent_budget_reductions (email_next_at)
  where emailed_at is null and not email_undeliverable;

alter table public.agent_budget_reductions enable row level security;
revoke all on table public.agent_budget_reductions from public, anon, authenticated;

-- 3. Reading and setting a budget.

-- What a billing account's spends count now, but for p_except: every spend
-- not given back whose counts_until has not passed. The one rule every sum
-- in this file uses.
create or replace function public.agent_budget_counted_cents(
  p_user_id uuid,
  p_team_id uuid,
  p_except  uuid
)
returns bigint
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(sum(s.amount_cents), 0)
    from public.agent_budget_spends s
   where (s.user_id = p_user_id or s.team_id = p_team_id)
     and (p_except is null or s.id <> p_except)
     and s.status <> 'returned'
     and s.counts_until > now();
$$;

-- What a billing account's budget is, what its spends count, what is left,
-- and its spends (counted ones, and any taken in the last 30 days, newest
-- first, at most 50), all read at the database's clock so the list and
-- the sum agree.
create or replace function public.agent_budget_state(p_user_id uuid, p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_budget integer;
  v_spent  bigint;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'name one billing account' using errcode = '22023';
  end if;
  if p_team_id is not null then
    select t.agent_budget_cents into v_budget from public.teams t where t.id = p_team_id;
  else
    select u.agent_budget_cents into v_budget from public.users u where u.id = p_user_id;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;
  v_spent := public.agent_budget_counted_cents(p_user_id, p_team_id, null);
  return jsonb_build_object(
    'status', 'ok',
    'budget', v_budget,
    'spent', v_spent,
    'left', greatest(v_budget - v_spent, 0),
    -- When the first counted spend stops counting, so more is left.
    'next_release', (
      select min(s.counts_until)
        from public.agent_budget_spends s
       where (s.user_id = p_user_id or s.team_id = p_team_id)
         and s.status <> 'returned'
         and s.counts_until > now()
    ),
    'spends', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', l.id,
               'description', l.description,
               'amount_cents', l.amount_cents,
               'status', l.status,
               'taken_at', l.taken_at,
               'counts_until', l.counts_until,
               'counted', l.status <> 'returned' and l.counts_until > now(),
               'key_id', l.key_id
             ) order by l.taken_at desc), '[]'::jsonb)
        from (
          select s.*
            from public.agent_budget_spends s
           where (s.user_id = p_user_id or s.team_id = p_team_id)
             -- Never the marks bury_lost_agent_budget_take leaves.
             and s.idempotency_key not like 'lost:%'
             and ((s.status <> 'returned' and s.counts_until > now())
                  or s.taken_at > now() - interval '30 days')
           order by s.taken_at desc
           limit 50
        ) l
    )
  );
end;
$$;

-- Whether a reduction (fewer seats, fewer monthly blocks) must wait for
-- the owner's approval rather than run on the budget: 'busy' while a spend
-- of the account is running or unsettled from the last 15 minutes (its
-- outcome is not known yet), 'overlap' for fewer seats (p_seats) at or
-- above the target of a seat spend still running or unsettled, since a
-- subscription showing those seats would settle that spend as made
-- (settle_agent_budget_from_subscription); else null.
create or replace function public.agent_budget_decrease_check(
  p_user_id uuid,
  p_team_id uuid,
  p_seats   integer
)
returns text
language sql
stable
security definer set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.agent_budget_spends s
       where (s.user_id = p_user_id or s.team_id = p_team_id)
         and s.status in ('running', 'unsettled')
         and s.taken_at > now() - interval '15 minutes'
    ) then 'busy'
    when p_seats is not null and exists (
      select 1 from public.agent_budget_spends s
       where (s.user_id = p_user_id or s.team_id = p_team_id)
         and s.status in ('running', 'unsettled')
         and s.counts_until > now()
         and s.target ? 'seats'
         and (s.target->>'seats')::integer <= p_seats
    ) then 'overlap'
  end;
$$;

-- The pending raises of an account's budget are refused (status 'denied',
-- which no decision can move) rather than expired: an expiry compared on
-- another clock could still let one be approved. Each carries the result
-- {"code": "budget_changed"}, which the asker's poll returns, so an agent
-- reads the budget again and asks again if it still needs the raise.
create or replace function public.deny_agent_budget_raises(p_user_id uuid, p_team_id uuid)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.approvals a
     set status = 'denied', decided_at = now(),
         result = jsonb_build_object('code', 'budget_changed')
   where a.action = 'billing.agent_budget'
     and a.status = 'pending'
     and (case when p_team_id is not null
               then a.params->>'teamId' = p_team_id::text
               else a.user_id = p_user_id and a.params->>'teamId' is null
          end);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Sets a budget. p_only_lower refuses a raise (an API key or agent token
-- may only lower it; raising needs the owner). p_expected, when given, is
-- the budget the change was asked against (an approved raise): when the
-- budget is something else now, nothing is set ('changed'), so a raise
-- approved after the owner lowered the budget never undoes that. Any
-- change refuses every raise of it still waiting for approval: each was
-- asked against the budget as it was, and a lower one is the owner's (or a
-- key's) latest word. Who may set a team's is checked by the web app (the
-- team's owner only).
drop function if exists public.set_agent_budget(uuid, uuid, integer, boolean);
create or replace function public.set_agent_budget(
  p_user_id    uuid,
  p_team_id    uuid,
  p_cents      integer,
  p_only_lower boolean,
  p_expected   integer default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_previous integer;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'name one billing account' using errcode = '22023';
  end if;
  if p_cents is null or p_cents < 0 or p_cents > 50000 then
    raise exception 'budget out of range: %', p_cents using errcode = '22023';
  end if;
  if p_team_id is not null then
    select t.agent_budget_cents into v_previous
      from public.teams t where t.id = p_team_id for no key update;
  else
    select u.agent_budget_cents into v_previous
      from public.users u where u.id = p_user_id for no key update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;
  if p_expected is not null and p_expected <> v_previous then
    return jsonb_build_object('status', 'changed', 'previous', v_previous);
  end if;
  if p_only_lower and p_cents > v_previous then
    return jsonb_build_object('status', 'raise_needs_owner', 'previous', v_previous);
  end if;
  if p_cents <> v_previous then
    if p_team_id is not null then
      update public.teams set agent_budget_cents = p_cents where id = p_team_id;
    else
      update public.users set agent_budget_cents = p_cents where id = p_user_id;
    end if;
  end if;
  -- A raise still waiting for approval was asked against the old budget,
  -- and would undo a lower one. The approval running this call is no
  -- longer pending, so it is not refused.
  if p_cents <> v_previous then
    perform public.deny_agent_budget_raises(p_user_id, p_team_id);
  end if;
  return jsonb_build_object('status', 'ok', 'previous', v_previous, 'budget', p_cents);
end;
$$;

-- 4. The take.

-- Takes p_cents for one change, or says why not:
--   key_reused  a spend with this key was taken for another change: an
--               Idempotency-Key names one change (a derived key hashes the
--               change, so only a header key can be reused)
--   off         the budget is 0
--   busy        a spend with another key is unsettled for the account, or
--               running for a run that died, in the last 15 minutes: its
--               outcome is not known yet. Runs that are alive are kept apart
--               by the billing change lease the caller holds.
--   over        less is left than the change needs ('left', 'needed')
--   existing    a spend with this key is taken already (running, unsettled
--               or applied: a retry): its row, with when it was taken, what
--               it was counted at, the period it was priced on, and what
--               the account's other spends count ('others'), so the caller
--               sends it again only while that still holds
--   taken       taken now ('id', 'left')
-- A spend given back is never found by its key: the same key takes a new
-- row. The insert carries the budget condition itself, under the account
-- row's lock. p_id is the id a new row takes, chosen by the caller, so a
-- take whose answer was lost can be looked up by it and given back.
drop function if exists public.take_agent_budget(uuid, uuid, text, integer, uuid, uuid, jsonb, text, text, jsonb, timestamptz, jsonb);
create or replace function public.take_agent_budget(
  p_user_id               uuid,
  p_team_id               uuid,
  p_idempotency_key       text,
  p_cents                 integer,
  p_key_id                uuid,
  p_agent_registration_id uuid,
  p_change                jsonb,
  p_description           text,
  p_subscription_id       text,
  p_target                jsonb,
  p_period_end            timestamptz,
  p_facts                 jsonb,
  p_id                    uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_budget integer;
  v_row    public.agent_budget_spends%rowtype;
  v_id     uuid;
  v_spent  bigint;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'name one billing account' using errcode = '22023';
  end if;
  if p_cents is null or p_cents < 0 then
    raise exception 'invalid amount: %', p_cents using errcode = '22023';
  end if;

  -- Serialise every take (and every raise from an order) on the account row.
  if p_team_id is not null then
    select t.agent_budget_cents into v_budget
      from public.teams t where t.id = p_team_id for no key update;
  else
    select u.agent_budget_cents into v_budget
      from public.users u where u.id = p_user_id for no key update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;

  perform 1
     from public.agent_budget_spends s
    where (s.user_id = p_user_id or s.team_id = p_team_id)
      and s.idempotency_key = p_idempotency_key
      and s.change is distinct from p_change;
  if found then
    return jsonb_build_object('status', 'key_reused');
  end if;

  select * into v_row
    from public.agent_budget_spends s
   where (s.user_id = p_user_id or s.team_id = p_team_id)
     and s.idempotency_key = p_idempotency_key
     and s.status <> 'returned';
  if found then
    v_spent := public.agent_budget_counted_cents(p_user_id, p_team_id, v_row.id);
    return jsonb_build_object(
      'status', 'existing',
      'id', v_row.id,
      'spend_status', v_row.status,
      'outcome', v_row.outcome,
      'stale', v_row.status = 'running' and v_row.updated_at < now() - interval '5 minutes',
      'taken_at', v_row.taken_at,
      'age_seconds', extract(epoch from now() - v_row.taken_at),
      'quoted_cents', v_row.quoted_cents,
      'amount_cents', v_row.amount_cents,
      'period_end', v_row.period_end,
      'budget', v_budget,
      'others', v_spent
    );
  end if;

  if v_budget = 0 then
    return jsonb_build_object('status', 'off');
  end if;

  perform 1
     from public.agent_budget_spends s
    where (s.user_id = p_user_id or s.team_id = p_team_id)
      and s.idempotency_key <> p_idempotency_key
      and s.status in ('running', 'unsettled')
      and s.taken_at > now() - interval '15 minutes';
  if found then
    return jsonb_build_object('status', 'busy');
  end if;

  -- A spend counts until 30 days after the renewal it was priced on when
  -- that renewal is at most 60 days away, so its rise, charged there, is
  -- inside a window: a monthly one, or an annual one at most 31 days away,
  -- counts the rise on top of the charge (riseCounted in
  -- lib/billing/agent-budget.ts), and an annual one further away counts the
  -- larger of the two, which then still holds until 30 days after the
  -- renewal. A renewal further than 60 days away counts 30 days from now,
  -- so an annual seat added earlier than that is not bounded at it.
  insert into public.agent_budget_spends (
    id, user_id, team_id, idempotency_key, key_id, agent_registration_id, change,
    description, quoted_cents, amount_cents, polar_subscription_id, target,
    period_end, facts, counts_until
  )
  select coalesce(p_id, gen_random_uuid()), p_user_id, p_team_id, p_idempotency_key,
         p_key_id, p_agent_registration_id,
         p_change, p_description, p_cents, p_cents, p_subscription_id,
         coalesce(p_target, '{}'::jsonb), p_period_end, coalesce(p_facts, '{}'::jsonb),
         case when p_period_end is not null and p_period_end <= now() + interval '60 days'
              then greatest(now(), p_period_end)
              else now()
         end + interval '30 days'
   where v_budget - public.agent_budget_counted_cents(p_user_id, p_team_id, null) >= p_cents
  returning id into v_id;

  v_spent := public.agent_budget_counted_cents(p_user_id, p_team_id, null);

  if v_id is null then
    return jsonb_build_object(
      'status', 'over',
      'budget', v_budget,
      'left', greatest(v_budget - v_spent, 0),
      'needed', p_cents
    );
  end if;
  return jsonb_build_object(
    'status', 'taken',
    'id', v_id,
    'budget', v_budget,
    'left', greatest(v_budget - v_spent, 0)
  );
end;
$$;

-- Frees a derived key from an applied spend that may not be replayed (made
-- more than a day ago, or Polar no longer shows its change), so the same
-- change asked for again takes a spend of its own. The row keeps counting;
-- only its key moves aside. Header keys are not retired here, but a header
-- key does not always find the spend it took: never one given back
-- (returned), and not one an order brought back after the key had taken
-- a new spend, whose key raise_agent_budget_from_order moves aside.
create or replace function public.retire_agent_budget_key(p_id uuid)
returns boolean
language sql
security definer set search_path = ''
as $$
  with retired as (
    update public.agent_budget_spends s
       set idempotency_key = left(s.idempotency_key, 150) || '#' || s.id::text,
           updated_at = now()
     where s.id = p_id
       and s.status = 'applied'
       and s.idempotency_key like 'd:%'
       and position('#' in s.idempotency_key) = 0
    returning 1
  )
  select exists (select 1 from retired);
$$;

-- A take whose answer was lost (lib/billing/agent-budget.ts returnLostTake)
-- and that the caller looked for twice without finding it: marks its id
-- with a row given back already, so a take still on its way fails on the
-- primary key and takes nothing. The mark counts nothing (returned), has
-- no subscription or target an order or a webhook could match, is never
-- emailed (emailed_at, email_undeliverable), and is left out of the list
-- (its 'lost:' key, which no real key has: those start 'd:' or 'h:').
-- Returns null when it left the mark, else the status of the spend the
-- take made under that id meanwhile, for the caller to give back.
create or replace function public.bury_lost_agent_budget_take(
  p_id      uuid,
  p_user_id uuid,
  p_team_id uuid
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  v_status text;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'name one billing account' using errcode = '22023';
  end if;
  insert into public.agent_budget_spends (
    id, user_id, team_id, idempotency_key, change, description, quoted_cents,
    amount_cents, status, counts_until, returned_at, emailed_at, email_undeliverable
  )
  values (
    p_id, p_user_id, p_team_id, 'lost:' || p_id::text, '{}'::jsonb,
    'A take whose answer was lost', 0, 0, 'returned', now(), now(), now(), true
  )
  on conflict (id) do nothing;
  if found then
    return null;
  end if;
  select s.status into v_status from public.agent_budget_spends s where s.id = p_id;
  return v_status;
end;
$$;

-- Takes a spend that is unsettled, or running but abandoned (no word for 5
-- minutes), for one more try of the same change, one request at a time.
-- p_cents is what the change counts at today, or null when it will not be
-- sent again (the try only looks at Polar):
--   * sent again: it is running again, counts the larger of p_cents and
--     what it counted at (a resend at today's quote is never counted below
--     it) for at least 30 days from now, and its status and emails start
--     again (status_changed_at, and email_undeliverable with its tries);
--   * only looking: it is (or stays) unsettled, held for five minutes by
--     retry_claimed_at, which the settle that follows clears, and nothing
--     else moves (updated_at and status_changed_at included), so a look
--     never stretches a window measured from them.
-- Returns what the spend counts at when this caller has it, else null. The
-- account row is locked first, as a take locks it, so a take never sums a
-- row that is being raised.
create or replace function public.claim_agent_budget_retry(p_id uuid, p_cents integer)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user   uuid;
  v_team   uuid;
  v_amount integer;
begin
  if p_cents is not null and p_cents < 0 then
    raise exception 'invalid amount: %', p_cents using errcode = '22023';
  end if;
  select s.user_id, s.team_id into v_user, v_team
    from public.agent_budget_spends s where s.id = p_id;
  if not found then
    return null;
  end if;
  if v_team is not null then
    perform 1 from public.teams t where t.id = v_team for no key update;
  else
    perform 1 from public.users u where u.id = v_user for no key update;
  end if;
  -- Its outcome is not known from here on, whatever this try finds.
  if p_cents is not null then
    update public.agent_budget_spends s
       set status = 'running',
           amount_cents = greatest(s.amount_cents, p_cents),
           unsettled_at = coalesce(s.unsettled_at, s.updated_at),
           counts_until = greatest(s.counts_until, now() + interval '30 days'),
           retry_claimed_at = null,
           email_undeliverable = false,
           email_attempts = 0,
           email_next_at = now(),
           status_changed_at = now(),
           updated_at = now()
     where s.id = p_id
       and ((s.status = 'unsettled'
             and (s.retry_claimed_at is null or s.retry_claimed_at < now() - interval '5 minutes'))
            or (s.status = 'running' and s.updated_at < now() - interval '5 minutes'))
    returning s.amount_cents into v_amount;
  else
    update public.agent_budget_spends s
       set status = 'unsettled',
           unsettled_at = coalesce(s.unsettled_at, s.updated_at),
           retry_claimed_at = now()
     where s.id = p_id
       and (s.status in ('unsettled', 'running'))
       and (s.status = 'unsettled' or s.updated_at < now() - interval '5 minutes')
       and (s.retry_claimed_at is null or s.retry_claimed_at < now() - interval '5 minutes')
    returning s.amount_cents into v_amount;
  end if;
  return v_amount;
end;
$$;

-- How a running spend ended: 'applied' (Polar made the change), 'unsettled'
-- (no answer: kept taken), or 'returned' (Polar refused it, a declined card
-- included: given back, p_outcome keeping its code, which
-- raise_agent_budget_from_order reads).
-- Only a running spend moves, so a webhook that settled it first wins, and
-- nothing that was applied is ever given back. What Polar already showed
-- wins over what the run says:
--   * a spend whose outcome was ever not known (unsettled_at), or that
--     Polar showed made, is never given back: 'returned' becomes
--     'unsettled' (the first try may have charged);
--   * a spend with its paid order (polar_order_id) or whose target a
--     subscription event showed (target_seen_at) is made: 'unsettled'
--     becomes 'applied'.
-- An applied spend without the answer a replay reads (an order or a
-- webhook made it) takes the answer given here. A spend made here leaves
-- email_undeliverable and its tries behind, so its 'spent' email goes out
-- even where the 'unknown' one was given up on; any settle drops a looking retry's hold
-- (retry_claimed_at). Returns the status it has.
create or replace function public.settle_agent_budget_spend(
  p_id      uuid,
  p_status  text,
  p_outcome jsonb
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row    public.agent_budget_spends%rowtype;
  v_status text := p_status;
begin
  if p_status not in ('applied', 'unsettled', 'returned') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;
  select * into v_row from public.agent_budget_spends s where s.id = p_id for update;
  if not found then
    return null;
  end if;
  if v_status = 'returned'
     and (v_row.unsettled_at is not null or v_row.polar_order_id is not null
          or v_row.target_seen_at is not null) then
    v_status := 'unsettled';
  end if;
  if v_status = 'unsettled'
     and (v_row.polar_order_id is not null or v_row.target_seen_at is not null) then
    v_status := 'applied';
  end if;
  if v_row.status = 'running' or (v_status = 'applied' and v_row.status = 'unsettled') then
    update public.agent_budget_spends s
       set status = v_status,
           outcome = coalesce(p_outcome, s.outcome),
           unsettled_at = case when v_status = 'unsettled' then coalesce(s.unsettled_at, now())
                               else s.unsettled_at end,
           returned_at = case when v_status = 'returned' then now() else s.returned_at end,
           email_undeliverable = case when v_status = 'applied' then false
                                      else s.email_undeliverable end,
           email_attempts = case when v_status = 'applied' then 0 else s.email_attempts end,
           email_next_at = case when v_status = 'applied' then now() else s.email_next_at end,
           status_changed_at = now(),
           retry_claimed_at = null,
           updated_at = now()
     where s.id = p_id;
    return v_status;
  end if;
  if v_row.retry_claimed_at is not null then
    update public.agent_budget_spends s set retry_claimed_at = null where s.id = p_id;
  end if;
  if v_status = 'applied' and v_row.status = 'applied' and p_outcome is not null
     and coalesce(v_row.outcome->>'executed', '') <> 'true' then
    update public.agent_budget_spends s
       set outcome = p_outcome, updated_at = now()
     where s.id = p_id;
  end if;
  return v_row.status;
end;
$$;

-- 5. Settling from Polar's webhooks.

-- A subscription event: spends on it whose target the subscription now
-- shows (the product, or exactly the seats asked for, so a later change of
-- the owner's own is never taken for the agent's) were made. An unsettled
-- spend, or one whose run died, is settled as made; a running one keeps its
-- run, which settles it, and records that Polar showed it (target_seen_at),
-- so a run that ends without an answer settles it as made. An unsettled
-- seat spend is also made by more seats than it asked for (the owner added
-- some on top), but only from an event within 15 minutes of when its
-- outcome was first not known (unsettled_at): later, more seats may be the
-- owner's alone. Returns the ids settled here.
create or replace function public.settle_agent_budget_from_subscription(
  p_subscription_id text,
  p_seats           integer,
  p_product_id      text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_ids jsonb;
begin
  update public.agent_budget_spends s
     set target_seen_at = coalesce(s.target_seen_at, now())
   where s.polar_subscription_id = p_subscription_id
     and s.counts_until > now()
     and s.status = 'running'
     and s.updated_at >= now() - interval '5 minutes'
     and (
       (s.target ? 'seats' and p_seats is not null and p_seats = (s.target->>'seats')::integer)
       or (s.target ? 'productId' and s.target->>'productId' = p_product_id)
     );
  with settled as (
    update public.agent_budget_spends s
       set status = 'applied',
           target_seen_at = coalesce(s.target_seen_at, now()),
           email_undeliverable = false,
           email_attempts = 0,
           email_next_at = now(),
           status_changed_at = now(),
           retry_claimed_at = null,
           updated_at = now()
     where s.polar_subscription_id = p_subscription_id
       and s.counts_until > now()
       and (s.status = 'unsettled'
            or (s.status = 'running' and s.updated_at < now() - interval '5 minutes'))
       and (
         (s.target ? 'seats' and p_seats is not null
          and (p_seats = (s.target->>'seats')::integer
               or (s.status = 'unsettled'
                   and p_seats > (s.target->>'seats')::integer
                   and s.unsettled_at >= now() - interval '15 minutes')))
         or (s.target ? 'productId' and s.target->>'productId' = p_product_id)
       )
    returning s.id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ids from settled;
  return v_ids;
end;
$$;

-- An order Polar was paid for a subscription change: counts the spend it
-- paid for at the larger of what it counts and the order's before-tax
-- amount (plus the rise of the next renewal when the spend counts it,
-- since the budget counts both), never less, counts it until at least 30
-- days after the payment (p_paid_at, a charge the bank had confirmed late
-- included), and marks it made. p_seats is the order's seats, or its
-- subscription's when the order carries none (the caller falls back).
--
-- A live spend (running, unsettled or applied) on that subscription
-- matches first: taken before the order and asked for no more than 10
-- minutes before its status last moved or it was last sent
-- (status_changed_at, so a retry sent late still matches, and a retry that
-- only looked does not stretch it), whose target is exactly what the order bought (its product,
-- or exactly its seats). Failing that, a spend given back in the last day
-- (the last 30 for a declined card, outcome code payment_failed, whose
-- charge Polar may collect through its payment retries days later) with
-- that exact target, taken before the order, and ordered no later than a
-- minute after it was given back: a run that gave back a spend whose first
-- try Polar charged after all brings it back, made and counted, rather than
-- leave the charge uncounted, while an order made after the give-back (the
-- owner's own change, say) never does. A redelivered order
-- found on its spend already made leaves when it counts until alone. The account row is
-- locked first, as a take locks it, so a take never sums a row that is
-- being raised. Returns the spend's id, its amounts and whether it was made
-- by this order, or null when none matches.
drop function if exists public.raise_agent_budget_from_order(text, text, integer, timestamptz, text, integer);
create or replace function public.raise_agent_budget_from_order(
  p_subscription_id text,
  p_order_id        text,
  p_net_cents       integer,
  p_ordered_at      timestamptz,
  p_product_id      text,
  p_seats           integer,
  p_paid_at         timestamptz default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row     public.agent_budget_spends%rowtype;
  v_before  integer;
  v_status  text;
  v_count   integer;
  v_paid    timestamptz := least(coalesce(p_paid_at, p_ordered_at, now()), now());
  v_revived boolean := false;
  v_again   boolean := false;
begin
  if p_net_cents is null or p_net_cents < 0 then
    return null;
  end if;
  select * into v_row
    from public.agent_budget_spends s
   where s.polar_order_id = p_order_id;
  if not found then
    select * into v_row
      from public.agent_budget_spends s
     where s.polar_subscription_id = p_subscription_id
       and s.polar_order_id is null
       and s.status <> 'returned'
       and s.counts_until > now()
       -- Taken before the order (a minute for the two clocks), and the
       -- order no later than 10 minutes after the spend last moved or was sent.
       and s.taken_at <= p_ordered_at + interval '1 minute'
       and p_ordered_at <= s.status_changed_at + interval '10 minutes'
       and (
         (s.target ? 'productId' and s.target->>'productId' = p_product_id)
         or (s.target ? 'seats' and p_seats is not null
             and p_seats = (s.target->>'seats')::integer)
       )
     order by s.taken_at desc
     limit 1;
    if not found then
      select * into v_row
        from public.agent_budget_spends s
       where s.polar_subscription_id = p_subscription_id
         and s.polar_order_id is null
         and s.status = 'returned'
         and s.returned_at > now() - case when s.outcome->>'code' = 'payment_failed'
                                          then interval '30 days' else interval '1 day' end
         and s.taken_at <= p_ordered_at + interval '1 minute'
         and p_ordered_at <= s.returned_at + interval '1 minute'
         and (
           (s.target ? 'productId' and s.target->>'productId' = p_product_id)
           or (s.target ? 'seats' and p_seats is not null
               and p_seats = (s.target->>'seats')::integer)
         )
       order by s.returned_at desc
       limit 1;
      if not found then
        return null;
      end if;
      v_revived := true;
    end if;
  elsif v_row.status = 'returned' then
    return null;
  else
    v_again := v_row.status = 'applied';
  end if;

  if v_row.team_id is not null then
    perform 1 from public.teams t where t.id = v_row.team_id for no key update;
  else
    perform 1 from public.users u where u.id = v_row.user_id for no key update;
  end if;

  select s.amount_cents, s.status into v_before, v_status
    from public.agent_budget_spends s where s.id = v_row.id for update;
  if v_revived then
    if v_status <> 'returned' then
      return null;
    end if;
    -- The key may have taken a new spend since: this one keeps counting
    -- under a key of its own.
    if exists (
      select 1 from public.agent_budget_spends o
       where o.id <> v_row.id
         and o.status <> 'returned'
         and o.idempotency_key = v_row.idempotency_key
         and (o.user_id = v_row.user_id or o.team_id = v_row.team_id)
    ) then
      update public.agent_budget_spends s
         set idempotency_key = left(s.idempotency_key, 150) || '#' || s.id::text
       where s.id = v_row.id;
    end if;
    v_before := 0;
  end if;
  v_count := p_net_cents + case
    when v_row.facts->>'riseCounted' = 'true'
         and jsonb_typeof(v_row.facts->'renewalRiseCents') = 'number'
      then greatest((v_row.facts->>'renewalRiseCents')::integer, 0)
    else 0
  end;
  update public.agent_budget_spends s
     set amount_cents = greatest(case when v_revived then s.quoted_cents else s.amount_cents end,
                                 v_count),
         polar_order_id = p_order_id,
         counts_until = case when v_again then s.counts_until
                             else greatest(s.counts_until, v_paid + interval '30 days') end,
         -- A running spend is its request's to settle (with the answer it
         -- keeps for a retry), and settles as made now that the order is
         -- here; an unsettled one, or one given back, is made by this order.
         status = case when s.status in ('unsettled', 'returned') then 'applied' else s.status end,
         returned_at = null,
         -- Made by this order: its 'spent' email goes out, even where the
         -- 'unknown' one had been given up on.
         email_undeliverable = case when s.status in ('unsettled', 'returned') then false
                                    else s.email_undeliverable end,
         email_attempts = case when s.status in ('unsettled', 'returned') then 0
                               else s.email_attempts end,
         email_next_at = case when s.status in ('unsettled', 'returned') then now()
                              else s.email_next_at end,
         status_changed_at = case when s.status in ('unsettled', 'returned') then now()
                                  else s.status_changed_at end,
         retry_claimed_at = case when s.status in ('unsettled', 'returned') then null
                                 else s.retry_claimed_at end,
         updated_at = now()
   where s.id = v_row.id;
  return jsonb_build_object(
    'id', v_row.id,
    'user_id', v_row.user_id,
    'team_id', v_row.team_id,
    'before', v_before,
    'after', greatest(case when v_revived then v_row.quoted_cents else v_before end, v_count),
    'made', v_status in ('unsettled', 'returned'),
    'revived', v_revived
  );
end;
$$;

-- Claims sending one of a spend's emails ('spent': the change was made;
-- 'unknown': it may have been): true when this caller sends it. Nothing is
-- claimed once that email went out, or the 'unknown' one once the change is
-- known made, for a spend whose email cannot be delivered or that has had
-- 30 tries, or while another sender's claim is under five minutes old. Each
-- claim counts a try.
create or replace function public.claim_agent_budget_email(p_id uuid, p_kind text)
returns boolean
language sql
security definer set search_path = ''
as $$
  with claimed as (
    update public.agent_budget_spends s
       set email_claimed_at = now(),
           email_attempts = s.email_attempts + 1
     where s.id = p_id
       and s.emailed_at is null
       and not s.email_undeliverable
       and s.email_attempts < 30
       and (p_kind = 'spent' or (p_kind = 'unknown' and s.unknown_emailed_at is null))
       and (s.email_claimed_at is null or s.email_claimed_at < now() - interval '5 minutes')
    returning 1
  )
  select exists (select 1 from claimed);
$$;

-- How long a failed notice waits before its next try: 2, 4, 8 ... minutes
-- by the tries so far, at most 6 hours.
create or replace function public.agent_budget_email_backoff(p_attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select least(interval '1 minute' * power(2, least(greatest(p_attempts, 1), 12)),
               interval '6 hours');
$$;

-- How an email claimed by claim_agent_budget_email ended: 'sent' records it
-- (again harmlessly: a time already recorded is kept, so a retry of this
-- call after a lost answer changes nothing), 'undeliverable' takes the
-- spend out of the queue (nobody to send it to), 'failed' drops the claim
-- and puts the next try off by the backoff, or, after the 30th try, takes
-- it out of the queue too (a backstop: the 7 days end it first).
create or replace function public.finish_agent_budget_email(p_id uuid, p_kind text, p_result text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_result not in ('sent', 'undeliverable', 'failed') then
    raise exception 'invalid result: %', p_result using errcode = '22023';
  end if;
  update public.agent_budget_spends s
     set emailed_at = case when p_result = 'sent' and p_kind = 'spent'
                           then coalesce(s.emailed_at, now()) else s.emailed_at end,
         unknown_emailed_at = case when p_result = 'sent' and p_kind = 'unknown'
                                   then coalesce(s.unknown_emailed_at, now())
                                   else s.unknown_emailed_at end,
         email_undeliverable = s.email_undeliverable or p_result = 'undeliverable'
                               or (p_result = 'failed' and s.email_attempts >= 30),
         -- A sent 'unknown' email leaves the 'spent' one to come: it starts
         -- with no tries behind it.
         email_attempts = case when p_result = 'sent' then 0 else s.email_attempts end,
         email_next_at = case when p_result = 'failed'
                              then now() + public.agent_budget_email_backoff(s.email_attempts)
                              else now() end,
         email_claimed_at = null
   where s.id = p_id;
end;
$$;

-- The spends whose email is due, oldest due first: 'spent' for one made
-- (whatever made it: the request, a webhook, an order), 'unknown' for one
-- whose outcome is not known, or a run that died (no word for 15 minutes).
-- A spend still unsent 7 days after its status last moved
-- (status_changed_at: an order, a webhook or a resend that moved it late
-- starts the 7 days again, a retry that only looked does not), or after 30
-- tries, is given up on (email_undeliverable) first, so the queue only
-- holds what may still go.
create or replace function public.pending_agent_budget_emails(p_limit integer)
returns table (spend_id uuid, kind text)
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.agent_budget_spends s
     set email_undeliverable = true
   where s.emailed_at is null
     and s.status <> 'returned'
     and not s.email_undeliverable
     and (s.status_changed_at < now() - interval '7 days' or s.email_attempts >= 30);
  return query
  select s.id, case when s.status = 'applied' then 'spent' else 'unknown' end
    from public.agent_budget_spends s
   where s.emailed_at is null
     and s.status <> 'returned'
     and not s.email_undeliverable
     and s.email_next_at <= now()
     and (s.email_claimed_at is null or s.email_claimed_at < now() - interval '5 minutes')
     and (s.status = 'applied'
          or (s.unknown_emailed_at is null
              and (s.status = 'unsettled'
                   or (s.status = 'running' and s.updated_at < now() - interval '15 minutes'))))
   order by s.email_next_at
   limit greatest(least(coalesce(p_limit, 25), 100), 1);
end;
$$;

-- Records a reduction a key made on the budget; its notice goes out from
-- claim_agent_budget_reduction_notice.
drop function if exists public.record_agent_budget_reduction(uuid, uuid, uuid, text, integer);
create or replace function public.record_agent_budget_reduction(
  p_user_id               uuid,
  p_team_id               uuid,
  p_key_id                uuid,
  p_description           text,
  p_renewal_cents         integer,
  p_agent_registration_id uuid default null
)
returns uuid
language sql
security definer set search_path = ''
as $$
  insert into public.agent_budget_reductions (
    user_id, team_id, key_id, agent_registration_id, description, renewal_cents
  )
  values (
    case when p_team_id is null then p_user_id end,
    p_team_id,
    p_key_id,
    p_agent_registration_id,
    left(p_description, 500),
    case when p_renewal_cents >= 0 then p_renewal_cents end
  )
  returning id;
$$;

-- Claims the account's next reduction notice: every reduction not yet
-- emailed (in the last 7 days; older ones are given up on), in one email.
-- At most one notice per account an hour: while one went out in the last
-- hour, or another sender holds a claim under five minutes old, nothing is
-- claimed ('wait', with when the next may go). Serialised on the account
-- row, so two senders never both pass the hour. Returns 'claimed' with the
-- claim and the reductions, 'wait', or 'none'.
create or replace function public.claim_agent_budget_reduction_notice(p_user_id uuid, p_team_id uuid)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_last  timestamptz;
  v_claim uuid := gen_random_uuid();
  v_rows  jsonb;
begin
  if num_nonnulls(p_user_id, p_team_id) <> 1 then
    raise exception 'name one billing account' using errcode = '22023';
  end if;
  if p_team_id is not null then
    perform 1 from public.teams t where t.id = p_team_id for no key update;
  else
    perform 1 from public.users u where u.id = p_user_id for no key update;
  end if;
  if not found then
    return jsonb_build_object('status', 'none');
  end if;

  update public.agent_budget_reductions r
     set email_undeliverable = true
   where (r.user_id = p_user_id or r.team_id = p_team_id)
     and r.emailed_at is null
     and not r.email_undeliverable
     and r.made_at < now() - interval '7 days';

  perform 1
     from public.agent_budget_reductions r
    where (r.user_id = p_user_id or r.team_id = p_team_id)
      and r.emailed_at is null
      and r.email_claimed_at > now() - interval '5 minutes';
  if found then
    return jsonb_build_object('status', 'wait', 'next_at', now() + interval '5 minutes');
  end if;

  select max(r.emailed_at) into v_last
    from public.agent_budget_reductions r
   where (r.user_id = p_user_id or r.team_id = p_team_id)
     and r.emailed_at > now() - interval '1 hour';
  if v_last is not null then
    return jsonb_build_object('status', 'wait', 'next_at', v_last + interval '1 hour');
  end if;

  with claimed as (
    update public.agent_budget_reductions r
       set email_claim = v_claim,
           email_claimed_at = now(),
           email_attempts = r.email_attempts + 1
     where (r.user_id = p_user_id or r.team_id = p_team_id)
       and r.emailed_at is null
       and not r.email_undeliverable
    returning r.id, r.key_id, r.agent_registration_id, r.description, r.renewal_cents, r.made_at
  )
  select jsonb_agg(jsonb_build_object(
           'id', c.id,
           'key_id', c.key_id,
           'agent_registration_id', c.agent_registration_id,
           'description', c.description,
           'renewal_cents', c.renewal_cents,
           'made_at', c.made_at
         ) order by c.made_at)
    into v_rows
    from claimed c;
  if v_rows is null then
    return jsonb_build_object('status', 'none');
  end if;
  return jsonb_build_object('status', 'claimed', 'claim', v_claim, 'reductions', v_rows);
end;
$$;

-- How a claimed reduction notice ended, as finish_agent_budget_email: 'sent'
-- (kept when already recorded), 'undeliverable', or 'failed' (the claim is
-- dropped and the next try put off by the backoff).
create or replace function public.finish_agent_budget_reduction_notice(p_claim uuid, p_result text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_result not in ('sent', 'undeliverable', 'failed') then
    raise exception 'invalid result: %', p_result using errcode = '22023';
  end if;
  update public.agent_budget_reductions r
     set emailed_at = case when p_result = 'sent' then coalesce(r.emailed_at, now())
                           else r.emailed_at end,
         email_undeliverable = r.email_undeliverable or p_result = 'undeliverable',
         email_next_at = case when p_result = 'failed'
                              then now() + public.agent_budget_email_backoff(r.email_attempts)
                              else r.email_next_at end,
         email_claimed_at = null
   where r.email_claim = p_claim;
end;
$$;

-- The accounts with a reduction notice due: reductions not yet emailed
-- whose next try has come, and no notice in the last hour.
create or replace function public.pending_agent_budget_reduction_notices(p_limit integer)
returns table (user_id uuid, team_id uuid)
language sql
stable
security definer set search_path = ''
as $$
  select distinct r.user_id, r.team_id
    from public.agent_budget_reductions r
   where r.emailed_at is null
     and not r.email_undeliverable
     and r.email_next_at <= now()
     and (r.email_claimed_at is null or r.email_claimed_at < now() - interval '5 minutes')
     and not exists (
       select 1 from public.agent_budget_reductions o
        where (o.user_id = r.user_id or o.team_id = r.team_id)
          and o.emailed_at > now() - interval '1 hour'
     )
   limit greatest(least(coalesce(p_limit, 25), 100), 1);
$$;

-- 6. Turning budgets off.

-- Every budget a person controls (their own and every team they own, by
-- an owner membership or as its creator, as account deletion finds them)
-- goes to 0, and every raise of one still waiting for their approval is
-- refused: a recovery code was spent or staff reset two-factor. Returns the
-- accounts whose budget was above 0.
create or replace function public.zero_agent_budgets_for_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user  integer;
  v_teams jsonb;
begin
  update public.users u set agent_budget_cents = 0
   where u.id = p_user_id and u.agent_budget_cents <> 0
  returning 1 into v_user;
  with zeroed as (
    update public.teams t set agent_budget_cents = 0
     where t.agent_budget_cents <> 0
       and (t.created_by = p_user_id
            or t.id in (
              select m.team_id from public.team_members m
               where m.user_id = p_user_id and m.role = 'owner'
            ))
    returning t.id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_teams from zeroed;
  update public.approvals a
     set status = 'denied', decided_at = now(),
         result = jsonb_build_object('code', 'budget_changed')
   where a.user_id = p_user_id
     and a.action = 'billing.agent_budget'
     and a.status = 'pending';
  return jsonb_build_object('user', v_user is not null, 'teams', v_teams);
end;
$$;

-- A team's budget is its owner's decision: any change of who owns it (an
-- owner membership added, moved, demoted or removed, or the team's creator
-- changed) turns it off and records why.
create or replace function public.zero_team_agent_budget_on_owner_change()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team uuid;
begin
  if tg_op = 'INSERT' then
    if new.role is distinct from 'owner' then return null; end if;
    v_team := new.team_id;
  elsif tg_op = 'DELETE' then
    if old.role is distinct from 'owner' then return null; end if;
    v_team := old.team_id;
  else
    if not ('owner' in (old.role, new.role))
       or (old.role is not distinct from new.role
           and old.user_id is not distinct from new.user_id
           and old.team_id is not distinct from new.team_id) then
      return null;
    end if;
    v_team := coalesce(new.team_id, old.team_id);
  end if;
  update public.teams t set agent_budget_cents = 0
   where t.id = v_team and t.agent_budget_cents <> 0;
  if found then
    insert into public.audit_events (actor_type, action, team_id, metadata)
    values ('system', 'billing.agent_budget_zeroed', v_team,
            jsonb_build_object('reason', 'owner_changed'));
  end if;
  -- A raise asked for before the change is no longer the owner's to give.
  perform public.deny_agent_budget_raises(null, v_team);
  return null;
end;
$$;

drop trigger if exists team_members_zero_agent_budget on public.team_members;
create trigger team_members_zero_agent_budget
  after insert or delete or update of role, user_id, team_id on public.team_members
  for each row execute function public.zero_team_agent_budget_on_owner_change();

create or replace function public.zero_team_agent_budget_on_creator_change()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    if new.agent_budget_cents <> 0 then
      new.agent_budget_cents := 0;
      insert into public.audit_events (actor_type, action, team_id, metadata)
      values ('system', 'billing.agent_budget_zeroed', new.id,
              jsonb_build_object('reason', 'owner_changed'));
    end if;
    perform public.deny_agent_budget_raises(null, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists teams_zero_agent_budget on public.teams;
create trigger teams_zero_agent_budget
  before update of created_by on public.teams
  for each row execute function public.zero_team_agent_budget_on_creator_change();

-- A raise asked for by a key that is revoked (its row deleted), or by an
-- agent whose registration is revoked, is refused: nobody is left to
-- collect it, and the owner should not be asked to give a budget to a key
-- they took away. Each carries the result {"code": "asker_revoked"}, as a
-- changed budget's carry {"code": "budget_changed"}. Before the delete,
-- since the approval's foreign key clears requested_by_key with it.
create or replace function public.deny_agent_budget_raises_of_key()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if tg_table_name = 'api_keys' then
    update public.approvals a
       set status = 'denied', decided_at = now(),
           result = jsonb_build_object('code', 'asker_revoked')
     where a.action = 'billing.agent_budget'
       and a.status = 'pending'
       and a.requested_by_key = old.id;
    return old;
  end if;
  if new.revoked_at is not null and old.revoked_at is null then
    update public.approvals a
       set status = 'denied', decided_at = now(),
           result = jsonb_build_object('code', 'asker_revoked')
     where a.action = 'billing.agent_budget'
       and a.status = 'pending'
       and a.requested_by_agent = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_deny_agent_budget_raises on public.api_keys;
create trigger api_keys_deny_agent_budget_raises
  before delete on public.api_keys
  for each row execute function public.deny_agent_budget_raises_of_key();

drop trigger if exists agent_registrations_deny_agent_budget_raises on public.agent_registrations;
create trigger agent_registrations_deny_agent_budget_raises
  after update of revoked_at on public.agent_registrations
  for each row execute function public.deny_agent_budget_raises_of_key();

-- An approval decided only while it is still in the state it was read in
-- and not expired, both at the database's clock, so an approval refused
-- or run out meanwhile (a lowered budget refuses its raises) is never
-- approved. p_status is the decision ('denied', 'approved', 'completed');
-- an approved or completed one gets p_ttl_seconds more for its asker to
-- collect it. True when this call decided it.
create or replace function public.decide_approval(
  p_id          uuid,
  p_from        text,
  p_status      text,
  p_ttl_seconds integer
)
returns boolean
language sql
security definer set search_path = ''
as $$
  with decided as (
    update public.approvals a
       set status = p_status,
           decided_at = now(),
           completed_at = case when p_status = 'completed' then now() else a.completed_at end,
           expires_at = case when p_status = 'denied' then a.expires_at
                             else now() + make_interval(secs => p_ttl_seconds) end
     where a.id = p_id
       and a.status = p_from
       and a.expires_at > now()
       and p_status in ('denied', 'approved', 'completed')
    returning 1
  )
  select exists (select 1 from decided);
$$;

-- 7. The approval that raises a budget asked for with a key: every action
-- on main (00098, 00099, 00101), billing.change (00106) and this one. One
-- statement drops and adds the check, so a lock timeout leaves the old one
-- in place; it is added NOT VALID and validated after, so the populated
-- approvals table is scanned without blocking writes.
alter table public.approvals
  drop constraint if exists approvals_action_check,
  add constraint approvals_action_check
    check (action in (
      'api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename',
      'google.connect', 'google.pick', 'ai.assist', 'teams.delete', 'teams.invite',
      'billing.change', 'billing.agent_budget'
    )) not valid;

alter table public.approvals validate constraint approvals_action_check;

-- Service role only.
revoke all on function public.agent_budget_counted_cents(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.agent_budget_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.agent_budget_decrease_check(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.deny_agent_budget_raises(uuid, uuid) from public, anon, authenticated;
revoke all on function public.deny_agent_budget_raises_of_key() from public, anon, authenticated;
revoke all on function public.decide_approval(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.set_agent_budget(uuid, uuid, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.take_agent_budget(uuid, uuid, text, integer, uuid, uuid, jsonb, text, text, jsonb, timestamptz, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.retire_agent_budget_key(uuid) from public, anon, authenticated;
revoke all on function public.claim_agent_budget_retry(uuid, integer) from public, anon, authenticated;
revoke all on function public.bury_lost_agent_budget_take(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.settle_agent_budget_spend(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.settle_agent_budget_from_subscription(text, integer, text) from public, anon, authenticated;
revoke all on function public.raise_agent_budget_from_order(text, text, integer, timestamptz, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_agent_budget_email(uuid, text) from public, anon, authenticated;
revoke all on function public.finish_agent_budget_email(uuid, text, text) from public, anon, authenticated;
revoke all on function public.agent_budget_email_backoff(integer) from public, anon, authenticated;
revoke all on function public.pending_agent_budget_emails(integer) from public, anon, authenticated;
revoke all on function public.record_agent_budget_reduction(uuid, uuid, uuid, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.claim_agent_budget_reduction_notice(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_agent_budget_reduction_notice(uuid, text) from public, anon, authenticated;
revoke all on function public.pending_agent_budget_reduction_notices(integer) from public, anon, authenticated;
revoke all on function public.zero_agent_budgets_for_user(uuid) from public, anon, authenticated;
revoke all on function public.zero_team_agent_budget_on_owner_change() from public, anon, authenticated;
revoke all on function public.zero_team_agent_budget_on_creator_change() from public, anon, authenticated;
grant execute on function public.agent_budget_counted_cents(uuid, uuid, uuid) to service_role;
grant execute on function public.agent_budget_state(uuid, uuid) to service_role;
grant execute on function public.agent_budget_decrease_check(uuid, uuid, integer) to service_role;
grant execute on function public.deny_agent_budget_raises(uuid, uuid) to service_role;
grant execute on function public.decide_approval(uuid, text, text, integer) to service_role;
grant execute on function public.set_agent_budget(uuid, uuid, integer, boolean, integer) to service_role;
grant execute on function public.take_agent_budget(uuid, uuid, text, integer, uuid, uuid, jsonb, text, text, jsonb, timestamptz, jsonb, uuid) to service_role;
grant execute on function public.retire_agent_budget_key(uuid) to service_role;
grant execute on function public.claim_agent_budget_retry(uuid, integer) to service_role;
grant execute on function public.bury_lost_agent_budget_take(uuid, uuid, uuid) to service_role;
grant execute on function public.settle_agent_budget_spend(uuid, text, jsonb) to service_role;
grant execute on function public.settle_agent_budget_from_subscription(text, integer, text) to service_role;
grant execute on function public.raise_agent_budget_from_order(text, text, integer, timestamptz, text, integer, timestamptz) to service_role;
grant execute on function public.claim_agent_budget_email(uuid, text) to service_role;
grant execute on function public.finish_agent_budget_email(uuid, text, text) to service_role;
grant execute on function public.agent_budget_email_backoff(integer) to service_role;
grant execute on function public.pending_agent_budget_emails(integer) to service_role;
grant execute on function public.record_agent_budget_reduction(uuid, uuid, uuid, text, integer, uuid) to service_role;
grant execute on function public.claim_agent_budget_reduction_notice(uuid, uuid) to service_role;
grant execute on function public.finish_agent_budget_reduction_notice(uuid, text) to service_role;
grant execute on function public.pending_agent_budget_reduction_notices(integer) to service_role;
grant execute on function public.zero_agent_budgets_for_user(uuid) to service_role;

notify pgrst, 'reload schema';
