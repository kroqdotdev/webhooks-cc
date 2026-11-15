-- Checkout links: an agent (an API key or a claimed agent token) or a
-- browser session asks for something the account can buy, and hands the
-- person a link to our own page, /checkout/{id}. Nothing is charged until
-- the person pays, so no approval is asked for; and no Polar checkout exists
-- until they open the link signed in as the billing account's owner (the
-- team's owner for a team), past two-factor sign-in when the account has it.
-- Only then is the purchase checked again and a Polar checkout session made
-- for it, so Polar's own link (which signs no one in, but takes a payment
-- for the customer) never reaches a key holder. The page first shows the
-- person what the link buys, who asked and from where, and makes nothing
-- until they choose to continue to payment.
--
-- One row per link: whose billing account it is for (the user, or the team
-- whose owner asked), what it buys (kind and item), our page's url, who
-- asked (the key or agent registration, so its own asker can follow it),
-- and, once opened, the Polar checkout session (its id only: the page asks
-- Polar for its url each time it reuses it) and what that session should
-- buy (expected). The Polar webhook marks a row paid when the session's
-- order or subscription arrives, recording what it actually holds (bought);
-- a read past expires_at settles it from Polar, at most every 30 seconds
-- (polar_checked_at), and one it could not settle expires as 'unsettled'
-- (expired_reason). A link whose subscription was ended as the account's
-- second plan subscription (a refund queued for review) is superseded, never
-- paid. A link answers 404 once its account or team is deleted: the rows
-- cascade with it.
--
-- Rows are written only by the web app's routes (service role); clients have
-- no access. reserve_billing_checkout() makes a link under a per-account
-- advisory lock, so the limits (5 links an hour, 3 open at once) hold against
-- concurrent requests. cleanup_billing_checkouts() deletes each row 30 days
-- after it was paid, superseded or expired, every day.

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
  -- Where the asker was, for the page to warn when the person opens the
  -- link from another network (as the approval page does): the /24 or /48
  -- the request came from (never the address), and Cloudflare's country.
  network             text check (char_length(network) <= 64),
  country             text check (char_length(country) <= 2),
  kind                text not null
                        check (kind in ('plan', 'team_plan', 'blocks', 'monthly_blocks', 'overage')),
  -- What it buys, as the route parsed it (plan, interval, seats, blocks,
  -- resource; an overage link's maximum is filled in by the route).
  item                jsonb not null default '{}'::jsonb,
  -- Our page for the link, on the site its asker uses (users.home_site).
  url                 text not null check (char_length(url) <= 2048),
  -- The Polar checkout session, once the person opened the link. Several
  -- team links can share a team's one open session. A link paid through a
  -- session it had replaced follows that session from then on (the newer
  -- one moves into previous_checkout_ids).
  polar_checkout_id   text,
  -- The session whose payment marked the link paid (or superseded), so a
  -- later payment of another of its sessions never changes what it bought
  -- or undoes a purchase that stands.
  paid_checkout_id    text,
  -- What that session buys: { product, seats?, units? }.
  expected            jsonb,
  -- What the paid order or subscription holds: { product, seats, units, amount, currency }.
  bought              jsonb,
  -- Why what was bought differs from what the link asked for, when the
  -- webhook can tell and the order alone cannot show it ('base': a monthly
  -- top-up paid on another starting count than the session was made for;
  -- 'replaced': a session the link had replaced with a new one was paid).
  mismatch            text check (mismatch in ('base', 'replaced')),
  -- The sessions this link followed before a reopen replaced them (the
  -- purchase moved, say a top-up's starting count): Polar cannot end a
  -- session, so a payment of one still marks the link paid, with mismatch
  -- 'replaced', rather than leave it open to expire, and a read past expiry
  -- asks Polar about them too before it calls the link expired.
  previous_checkout_ids text[] not null default '{}'
                        check (cardinality(previous_checkout_ids) <= 20),
  -- When the asker cancelled the link. A tab that was opening it meanwhile
  -- may still have made a team's session that names it in its metadata, and
  -- a payment of that session never marks a cancelled link paid.
  cancelled_at        timestamptz,
  -- When a team's open session this link followed was moved to another
  -- purchase: the session's metadata may still name the link, so a payment
  -- of that session never marks it paid through the metadata.
  detached_at         timestamptz,
  -- A lease while a session is being made for it, so two tabs make one.
  opening_at          timestamptz,
  -- When the person first continued to payment (the first opening lease):
  -- from then on a Polar session may exist for the link, a team's that
  -- names it in its metadata included, so a payment may still land after
  -- it expires. Kept when the session is later detached or replaced.
  opened_at           timestamptz,
  -- The last time a read past expiry asked Polar about the session.
  polar_checked_at    timestamptz,
  status              text not null default 'open'
                        check (status in ('open', 'paid', 'expired', 'superseded')),
  -- Why an opened link expired without being paid, when Polar never said
  -- it was not: 'unsettled', a payment Polar was still confirming a day
  -- past its expiry, or sessions Polar could not be read about 15 minutes
  -- past it. Such a link may have been paid (the payment still marks it
  -- paid when it lands), so it never reads "nothing was charged", and
  -- someone is alerted.
  expired_reason      text check (expired_reason in ('unsettled')),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  paid_at             timestamptz,
  constraint billing_checkouts_one_account check ((user_id is null) <> (team_id is null))
);

-- The webhook finds a link by its session.
create index if not exists billing_checkouts_polar_checkout
  on public.billing_checkouts (polar_checkout_id) where polar_checkout_id is not null;
-- And by a session it replaced. Not partial: a `@>` query carries no
-- predicate that would prove a partial index's WHERE, so the planner would
-- never use one.
create index if not exists billing_checkouts_previous_checkouts
  on public.billing_checkouts using gin (previous_checkout_ids);
-- And by the session that paid it.
create index if not exists billing_checkouts_paid_checkout
  on public.billing_checkouts (paid_checkout_id) where paid_checkout_id is not null;
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

-- Makes a checkout link on one billing account, or raises
-- checkout_links_hourly_limit (5 made in the last hour, whatever became of
-- them) or checkout_links_open_limit (3 still open). Its url is
-- p_origin/checkout/{id}; it expires in an hour unless a Polar session made
-- for it lasts longer. Returns the new row's id.
create or replace function public.reserve_billing_checkout(
  p_user_id    uuid,
  p_team_id    uuid,
  p_created_by uuid,
  p_key_id     uuid,
  p_agent_id   uuid,
  p_kind       text,
  p_item       jsonb,
  p_origin     text,
  p_network    text,
  p_country    text
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  made_last_hour integer;
  still_open     integer;
  new_id         uuid := gen_random_uuid();
begin
  if (p_user_id is null) = (p_team_id is null) then
    raise exception 'billing_checkouts: exactly one of p_user_id and p_team_id';
  end if;
  if p_origin is null or p_origin !~ '^https?://[^/]+$' then
    raise exception 'billing_checkouts: p_origin must be an origin';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('billing_checkouts:' || coalesce(p_team_id, p_user_id)::text, 0)
  );

  select
    count(*) filter (where c.created_at > now() - interval '1 hour'),
    count(*) filter (where c.status = 'open' and c.expires_at > now())
  into made_last_hour, still_open
  from public.billing_checkouts c
  where (
      (p_team_id is not null and c.team_id = p_team_id)
      or (p_team_id is null and c.user_id = p_user_id)
    )
    -- Open rows past a day are past any link's expiry.
    and c.created_at > now() - interval '1 day';

  if made_last_hour >= 5 then
    raise exception 'checkout_links_hourly_limit';
  end if;
  if still_open >= 3 then
    raise exception 'checkout_links_open_limit';
  end if;

  insert into public.billing_checkouts (
    id, user_id, team_id, created_by, requested_by_key, requested_by_agent, network, country,
    kind, item, url, expires_at
  ) values (
    new_id, p_user_id, p_team_id, p_created_by, p_key_id, p_agent_id, p_network, p_country, p_kind,
    coalesce(p_item, '{}'::jsonb), p_origin || '/checkout/' || new_id::text,
    now() + interval '1 hour'
  );

  return new_id;
end;
$$;

revoke all on function public.reserve_billing_checkout(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_billing_checkout(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  to service_role;

-- Deletes links 30 days after they were paid or superseded, or after they
-- expired (an open row past its expiry is expired whether or not a read
-- settled it). By then the asker has long stopped following them, and a
-- late Polar event for one changes nothing. The table stays small (5 links
-- an hour per account), so one statement a day needs no batching or index
-- of its own.
create or replace function public.cleanup_billing_checkouts()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.billing_checkouts
  -- paid_at is set for paid and superseded links, so the others count from expiry.
  where coalesce(paid_at, expires_at) <= now() - interval '30 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.cleanup_billing_checkouts() from public, anon, authenticated;
grant execute on function public.cleanup_billing_checkouts() to service_role;

-- pg_cron upserts named jobs; unscheduling first keeps a re-run from ever
-- leaving a duplicate.
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-billing-checkouts';
select cron.schedule(
  'cleanup-billing-checkouts',
  '23 4 * * *',
  'select public.cleanup_billing_checkouts();'
);

notify pgrst, 'reload schema';
