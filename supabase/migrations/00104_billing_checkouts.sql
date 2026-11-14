-- Checkout links: an agent (an API key or a claimed agent token) or a
-- browser session asks for a Polar checkout for something the account can
-- buy, and hands its link to the person, who pays on Polar's page with their
-- own card. Nothing is charged until they do, so no approval is asked for.
--
-- One row per link: whose billing account it is for (the user, or the team
-- whose owner asked), what it buys (kind and item), the Polar checkout it
-- opened, and who asked (the key or agent registration, so its own asker can
-- follow it). The Polar webhook marks a row paid when the checkout's order or
-- subscription arrives; a read past expires_at marks it expired.
--
-- Rows are written only by the web app's routes (service role); clients have
-- no access. reserve_billing_checkout() takes a slot under a per-account
-- advisory lock, so the limits (5 links an hour, 3 open at once) hold against
-- concurrent requests; the route fills in the Polar checkout afterwards, or
-- deletes the slot when Polar refuses.

create table if not exists public.billing_checkouts (
  id                  uuid primary key default gen_random_uuid(),
  -- The billing account: exactly one of the two.
  user_id             uuid references public.users(id) on delete cascade,
  team_id             uuid references public.teams(id) on delete cascade,
  -- The person whose key, agent or session asked: the account's user, or
  -- the team's owner. Only they can read the row back.
  created_by          uuid not null references public.users(id) on delete cascade,
  requested_by_key    uuid references public.api_keys(id) on delete set null,
  requested_by_agent  uuid references public.agent_registrations(id) on delete set null,
  kind                text not null
                        check (kind in ('plan', 'team_plan', 'blocks', 'monthly_blocks', 'overage')),
  -- What it buys, as the route parsed it (plan, interval, seats, blocks, resource).
  item                jsonb not null default '{}'::jsonb,
  polar_checkout_id   text,
  url                 text check (char_length(url) <= 2048),
  -- creating: a slot taken, Polar not answered yet (expires_at is a short lease).
  status              text not null default 'creating'
                        check (status in ('creating', 'open', 'paid', 'expired')),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  paid_at             timestamptz,
  constraint billing_checkouts_one_account check ((user_id is null) <> (team_id is null)),
  constraint billing_checkouts_open_has_checkout
    check (status = 'creating' or polar_checkout_id is not null)
);

create unique index if not exists billing_checkouts_polar_checkout
  on public.billing_checkouts (polar_checkout_id);
-- The limits count an account's recent rows.
create index if not exists billing_checkouts_user_created
  on public.billing_checkouts (user_id, created_at) where user_id is not null;
create index if not exists billing_checkouts_team_created
  on public.billing_checkouts (team_id, created_at) where team_id is not null;
-- Foreign keys, for the cascades.
create index if not exists billing_checkouts_created_by on public.billing_checkouts (created_by);
create index if not exists billing_checkouts_requested_by_key
  on public.billing_checkouts (requested_by_key) where requested_by_key is not null;
create index if not exists billing_checkouts_requested_by_agent
  on public.billing_checkouts (requested_by_agent) where requested_by_agent is not null;

-- Server routes only (service role); clients have no access.
alter table public.billing_checkouts enable row level security;
revoke all on table public.billing_checkouts from anon, authenticated;

-- Takes a slot for a new checkout link on one billing account, or raises
-- checkout_links_hourly_limit (5 made in the last hour, whatever became of
-- them) or checkout_links_open_limit (3 still open or being made). Returns
-- the new row's id, status creating, with a two-minute lease the route
-- replaces with Polar's own expiry.
create or replace function public.reserve_billing_checkout(
  p_user_id    uuid,
  p_team_id    uuid,
  p_created_by uuid,
  p_key_id     uuid,
  p_agent_id   uuid,
  p_kind       text,
  p_item       jsonb
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  made_last_hour integer;
  still_open     integer;
  new_id         uuid;
begin
  if (p_user_id is null) = (p_team_id is null) then
    raise exception 'billing_checkouts: exactly one of p_user_id and p_team_id';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('billing_checkouts:' || coalesce(p_team_id, p_user_id)::text, 0)
  );

  select
    count(*) filter (where c.created_at > now() - interval '1 hour'),
    count(*) filter (where c.status in ('creating', 'open') and c.expires_at > now())
  into made_last_hour, still_open
  from public.billing_checkouts c
  where (
      (p_team_id is not null and c.team_id = p_team_id)
      or (p_team_id is null and c.user_id = p_user_id)
    )
    -- Open rows past a day are past any Polar checkout's expiry.
    and c.created_at > now() - interval '1 day';

  if made_last_hour >= 5 then
    raise exception 'checkout_links_hourly_limit';
  end if;
  if still_open >= 3 then
    raise exception 'checkout_links_open_limit';
  end if;

  insert into public.billing_checkouts (
    user_id, team_id, created_by, requested_by_key, requested_by_agent, kind, item, expires_at
  ) values (
    p_user_id, p_team_id, p_created_by, p_key_id, p_agent_id, p_kind, coalesce(p_item, '{}'::jsonb),
    now() + interval '2 minutes'
  )
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.reserve_billing_checkout(uuid, uuid, uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.reserve_billing_checkout(uuid, uuid, uuid, uuid, uuid, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
