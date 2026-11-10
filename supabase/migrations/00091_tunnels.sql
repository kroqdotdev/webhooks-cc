-- ============================================================================
-- 00091: tunnels (`whk share` previews and `whk tunnel --live`)
-- ============================================================================
-- The edge (apps/edge-rs) holds tunnels from the CLI and serves previews on
-- the preview domain; the web app is its control plane (app/api/edge/*,
-- lib/tunnels/). Everything here is read and written by the web app with the
-- service role; clients have no access.
--
-- plan_entitlements: share_slots (live previews at once), share_session_minutes
--   (null for no limit), share_data_gb (what visitors may take a UTC month),
--   reserved_names and share_passwords. Team plans count per member.
--
-- tunnel_names: names kept by an account (or kept inside one of its teams,
--   team_id, so every member may share under it), with an optional password
--   that holds for every share under the name. Free previews never get one:
--   their random names end in -free, which no kept name may.
--
-- tunnel_shares: one row per CLI run. kind 'share' is a preview at a name;
--   kind 'live' relays an endpoint's captures down the tunnel (no name). One
--   open preview per name and one open live session per endpoint, by partial
--   unique indexes. instance is the CLI's run id, so a run that was stopped
--   cannot come back by reconnecting. client_address is cleared 90 days after
--   the run ended (a year when it was reported for child sexual abuse).
--
-- tunnel_usage / tunnel_usage_batches: what visitors took, per account and
--   UTC month, added once per numbered batch from the edge.
--
-- tunnel_blocked_names / tunnel_blocked_words: staff's lists.
--
-- abuse_reports: reports of previews, from the public form, the edge's
--   phishing flags and the daily reputation check.
--
-- users.paid_since / teams.paid_since: when the account (or team) first got a
--   paid plan, set by triggers. New paid accounts' previews show the visitor
--   notice for 7 days after it, unless staff set users.tunnel_notice_lifted.
--   Accounts paying before this migration are backdated past the 7 days.
--   users.tunnels_suspended: staff took sharing away from the account (after
--   a report); its runs are stopped and new ones refused.
--
-- endpoints.live_session_id: the open live session of the endpoint, for the
--   receiver (phase 3). Set and cleared by tunnel_open_share and
--   tunnel_end_shares; a job clears any left behind.
--
-- requests.live_response: what the app answered a live capture (status,
--   headers, the first 64 KB of the body), written by the receiver (phase 3).
--   Nullable without a default, so adding it only changes the catalog.
--
-- Functions, all service-role only:
--   tunnel_open_share(...)     opens a run under the plan's slot count
--   tunnel_end_shares(ids, reason) ends runs, clears live_session_id
--   tunnel_close_all_open(reason)  the edge restarted
--   tunnel_apply_usage_batch(id, usage, month) adds one batch, once
--   tunnel_reserve_name(...)   keeps a name under the plan's count
--
-- The index on endpoints(live_session_id) is built concurrently after the
-- transaction, so apply this file in autocommit mode as AGENTS.md shows.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Entitlements
-- ---------------------------------------------------------------------------

alter table public.plan_entitlements
  add column if not exists share_slots integer not null default 0 check (share_slots >= 0),
  add column if not exists share_session_minutes integer check (share_session_minutes is null or share_session_minutes > 0),
  add column if not exists share_data_gb integer not null default 0 check (share_data_gb >= 0),
  add column if not exists reserved_names integer not null default 0 check (reserved_names >= 0),
  add column if not exists share_passwords boolean not null default false;

update public.plan_entitlements as pe
   set share_slots = v.slots,
       share_session_minutes = v.minutes,
       share_data_gb = v.gb,
       reserved_names = v.names,
       share_passwords = v.passwords
  from (values
    ('free',          1,  120::integer, 1,   0,  false),
    ('pro',           3,  null,         25,  3,  true),
    ('business',      10, null,         150, 20, true),
    ('team',          3,  null,         25,  3,  true),
    ('team_business', 10, null,         150, 20, true)
  ) as v(key, slots, minutes, gb, names, passwords)
 where pe.key = v.key;

-- ---------------------------------------------------------------------------
-- When an account or team first paid
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists paid_since timestamptz,
  add column if not exists tunnel_notice_lifted boolean not null default false,
  add column if not exists tunnels_suspended boolean not null default false;

alter table public.teams
  add column if not exists paid_since timestamptz;

-- Accounts and teams paying today are past the new-account notice.
update public.users
   set paid_since = least(created_at, now() - interval '8 days')
 where plan <> 'free' and paid_since is null;

update public.teams
   set paid_since = least(created_at, now() - interval '8 days')
 where subscription_status is not null and paid_since is null;

create or replace function public.users_note_paid_since()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.plan <> 'free' and new.paid_since is null then
    new.paid_since := now();
  end if;
  return new;
end;
$$;

revoke all on function public.users_note_paid_since() from public, anon, authenticated;

drop trigger if exists users_note_paid_since on public.users;
create trigger users_note_paid_since
  before insert or update of plan on public.users
  for each row
  when (new.plan <> 'free' and new.paid_since is null)
  execute function public.users_note_paid_since();

create or replace function public.teams_note_paid_since()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subscription_status is not null and new.paid_since is null then
    new.paid_since := now();
  end if;
  return new;
end;
$$;

revoke all on function public.teams_note_paid_since() from public, anon, authenticated;

drop trigger if exists teams_note_paid_since on public.teams;
create trigger teams_note_paid_since
  before insert or update of subscription_status on public.teams
  for each row
  when (new.subscription_status is not null and new.paid_since is null)
  execute function public.teams_note_paid_since();

-- ---------------------------------------------------------------------------
-- Names
-- ---------------------------------------------------------------------------

create table if not exists public.tunnel_names (
  name             text primary key,
  user_id          uuid not null references public.users(id) on delete cascade,
  team_id          uuid references public.teams(id) on delete set null,
  password_hash    text,
  password_version text,
  created_at       timestamptz not null default now(),
  constraint tunnel_names_shape check (
    name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    and position('--' in name) = 0
    and name !~ '-free$'
  ),
  constraint tunnel_names_password check ((password_hash is null) = (password_version is null))
);

create index if not exists tunnel_names_user on public.tunnel_names (user_id);
create index if not exists tunnel_names_team on public.tunnel_names (team_id) where team_id is not null;

alter table public.tunnel_names enable row level security;
revoke all on table public.tunnel_names from anon, authenticated;

create table if not exists public.tunnel_blocked_names (
  name       text primary key,
  reason     text not null default '' check (char_length(reason) <= 300),
  blocked_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.tunnel_blocked_names enable row level security;
revoke all on table public.tunnel_blocked_names from anon, authenticated;

create table if not exists public.tunnel_blocked_words (
  word       text primary key check (word ~ '^[a-z0-9]{3,40}$'),
  reason     text not null default '' check (char_length(reason) <= 300),
  blocked_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.tunnel_blocked_words enable row level security;
revoke all on table public.tunnel_blocked_words from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table if not exists public.tunnel_shares (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('share', 'live')),
  user_id          uuid not null references public.users(id) on delete cascade,
  name             text,
  endpoint_id      uuid references public.endpoints(id) on delete cascade,
  free             boolean not null default false,
  client           text not null default '' check (char_length(client) <= 100),
  key_id           uuid references public.api_keys(id) on delete set null,
  instance         text check (instance is null or char_length(instance) <= 64),
  client_address   text check (client_address is null or char_length(client_address) <= 64),
  started_at       timestamptz not null default now(),
  expires_at       timestamptz,
  ended_at         timestamptz,
  end_reason       text check (end_reason is null or char_length(end_reason) <= 40),
  password_hash    text,
  password_version text,
  bytes            bigint not null default 0 check (bytes >= 0),
  requests         bigint not null default 0 check (requests >= 0),
  constraint tunnel_shares_kind_shape check (
    (kind = 'share' and name is not null and endpoint_id is null)
    or (kind = 'live' and name is null and endpoint_id is not null)
  ),
  constraint tunnel_shares_password check ((password_hash is null) = (password_version is null))
);

-- One open preview per name, one open live session per endpoint.
create unique index if not exists tunnel_shares_open_name
  on public.tunnel_shares (name) where ended_at is null and kind = 'share';
create unique index if not exists tunnel_shares_open_endpoint
  on public.tunnel_shares (endpoint_id) where ended_at is null and kind = 'live';
-- An account's runs, newest first; its open ones for the slot count.
create index if not exists tunnel_shares_user_started
  on public.tunnel_shares (user_id, started_at desc);
create index if not exists tunnel_shares_user_open
  on public.tunnel_shares (user_id) where ended_at is null;
-- A reconnecting run, by its id.
create index if not exists tunnel_shares_user_instance
  on public.tunnel_shares (user_id, instance) where instance is not null;
-- Stopping the runs of a revoked key.
create index if not exists tunnel_shares_key_open
  on public.tunnel_shares (key_id) where ended_at is null and key_id is not null;
-- The address clean-up.
create index if not exists tunnel_shares_address_ended
  on public.tunnel_shares (ended_at) where client_address is not null;
create index if not exists tunnel_shares_endpoint
  on public.tunnel_shares (endpoint_id) where endpoint_id is not null;

alter table public.tunnel_shares enable row level security;
revoke all on table public.tunnel_shares from anon, authenticated;

alter table public.endpoints
  add column if not exists live_session_id uuid;

alter table public.requests
  add column if not exists live_response jsonb;

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

create table if not exists public.tunnel_usage (
  user_id   uuid not null references public.users(id) on delete cascade,
  month     date not null check (extract(day from month) = 1),
  bytes     bigint not null default 0 check (bytes >= 0),
  requests  bigint not null default 0 check (requests >= 0),
  paused_at timestamptz,
  primary key (user_id, month)
);

-- Accounts heavy this month, for the edge's paused list.
create index if not exists tunnel_usage_month_bytes on public.tunnel_usage (month, bytes);

alter table public.tunnel_usage enable row level security;
revoke all on table public.tunnel_usage from anon, authenticated;

create table if not exists public.tunnel_usage_batches (
  id         text primary key check (char_length(id) between 1 and 80),
  applied_at timestamptz not null default now()
);

create index if not exists tunnel_usage_batches_applied on public.tunnel_usage_batches (applied_at);

alter table public.tunnel_usage_batches enable row level security;
revoke all on table public.tunnel_usage_batches from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table if not exists public.abuse_reports (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('form', 'flag', 'reputation')),
  kind              text not null check (kind in (
                      'phishing', 'malware', 'csam', 'illegal', 'copyright',
                      'spam', 'privacy', 'other')),
  url               text not null check (char_length(url) <= 2000),
  name              text check (name is null or char_length(name) <= 63),
  user_id           uuid references public.users(id) on delete set null,
  share_id          uuid references public.tunnel_shares(id) on delete set null,
  details           text not null default '' check (char_length(details) <= 4000),
  reporter_name     text check (reporter_name is null or char_length(reporter_name) <= 200),
  reporter_email    text check (reporter_email is null or char_length(reporter_email) <= 320),
  good_faith        boolean not null default false,
  status            text not null default 'open' check (status in ('open', 'resolved')),
  outcome           text check (outcome is null or char_length(outcome) <= 200),
  statement_sent_at timestamptz,
  resolved_by       uuid references public.users(id) on delete set null,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists abuse_reports_open on public.abuse_reports (created_at desc) where status = 'open';
create index if not exists abuse_reports_share on public.abuse_reports (share_id) where share_id is not null;
create index if not exists abuse_reports_user on public.abuse_reports (user_id) where user_id is not null;

alter table public.abuse_reports enable row level security;
revoke all on table public.abuse_reports from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Opens a run. A preview under a name the same account already runs replaces
-- that run (the newest connection wins); a live session replaces the
-- account's open one on the same endpoint. Otherwise the account's open runs
-- of the kind must stay under p_slots. Answers {"shareId", "startedAt",
-- "expiresAt"} or {"error": "slots" | "taken"}.
create or replace function public.tunnel_open_share(
  p_user_id uuid,
  p_kind text,
  p_name text,
  p_endpoint_id uuid,
  p_slots integer,
  p_session_minutes integer,
  p_free boolean,
  p_client text,
  p_key_id uuid,
  p_instance text,
  p_client_address text,
  p_password_hash text,
  p_password_version text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_open integer;
  v_row public.tunnel_shares;
begin
  if p_kind not in ('share', 'live') then
    raise exception 'tunnel_open_share: bad kind %', p_kind using errcode = '22023';
  end if;

  -- One open at a time per account, so the count holds.
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('error', 'gone');
  end if;

  select count(*) into v_open
    from public.tunnel_shares s
   where s.user_id = p_user_id
     and s.ended_at is null
     and s.kind = p_kind
     and not (p_kind = 'share' and s.name = p_name)
     and not (p_kind = 'live' and s.endpoint_id = p_endpoint_id);
  if v_open >= p_slots then
    return jsonb_build_object('error', 'slots', 'open', v_open);
  end if;

  update public.tunnel_shares s
     set ended_at = now(), end_reason = 'replaced'
   where s.user_id = p_user_id
     and s.ended_at is null
     and s.kind = p_kind
     and ((p_kind = 'share' and s.name = p_name)
       or (p_kind = 'live' and s.endpoint_id = p_endpoint_id));

  begin
    insert into public.tunnel_shares (
      kind, user_id, name, endpoint_id, free, client, key_id, instance,
      client_address, expires_at, password_hash, password_version
    ) values (
      p_kind, p_user_id,
      case when p_kind = 'share' then p_name end,
      case when p_kind = 'live' then p_endpoint_id end,
      p_free, left(coalesce(p_client, ''), 100), p_key_id, left(p_instance, 64),
      left(p_client_address, 64),
      case when p_session_minutes is null then null
           else now() + make_interval(mins => p_session_minutes) end,
      p_password_hash, p_password_version
    )
    returning * into v_row;
  exception when unique_violation then
    return jsonb_build_object('error', 'taken');
  end;

  if p_kind = 'live' then
    update public.endpoints set live_session_id = v_row.id where id = p_endpoint_id;
  end if;

  return jsonb_build_object(
    'shareId', v_row.id,
    'startedAt', v_row.started_at,
    'expiresAt', v_row.expires_at
  );
end;
$$;

revoke all on function public.tunnel_open_share(uuid, text, text, uuid, integer, integer, boolean, text, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.tunnel_open_share(uuid, text, text, uuid, integer, integer, boolean, text, uuid, text, text, text, text)
  to service_role;

-- Ends the open runs among p_ids with p_reason and clears the live session
-- they held on their endpoints. Answers the runs it ended.
create or replace function public.tunnel_end_shares(p_ids uuid[], p_reason text)
returns table (id uuid, user_id uuid, kind text, name text, endpoint_id uuid)
language plpgsql
set search_path = ''
as $$
begin
  return query
  with ended as (
    update public.tunnel_shares s
       set ended_at = now(), end_reason = left(p_reason, 40)
     where s.id = any(p_ids) and s.ended_at is null
    returning s.id, s.user_id, s.kind, s.name, s.endpoint_id
  ), cleared as (
    update public.endpoints e
       set live_session_id = null
      from ended
     where ended.kind = 'live'
       and e.id = ended.endpoint_id
       and e.live_session_id = ended.id
    returning e.id
  )
  select ended.id, ended.user_id, ended.kind, ended.name, ended.endpoint_id
    from ended;
end;
$$;

revoke all on function public.tunnel_end_shares(uuid[], text) from public, anon, authenticated;
grant execute on function public.tunnel_end_shares(uuid[], text) to service_role;

-- The edge (re)started: every run it held is gone.
create or replace function public.tunnel_close_all_open(p_reason text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  with ended as (
    update public.tunnel_shares
       set ended_at = now(), end_reason = left(p_reason, 40)
     where ended_at is null
    returning id
  )
  select count(*) into v_count from ended;
  update public.endpoints set live_session_id = null where live_session_id is not null;
  return v_count;
end;
$$;

revoke all on function public.tunnel_close_all_open(text) from public, anon, authenticated;
grant execute on function public.tunnel_close_all_open(text) to service_role;

-- Adds one batch of counts from the edge, once: p_usage is
-- [{"id": <share id>, "bytes": n, "requests": n}, ...]. Counts for runs that
-- are gone are dropped; live sessions are never counted as data. Answers
-- false when the batch was added before.
create or replace function public.tunnel_apply_usage_batch(p_batch_id text, p_usage jsonb, p_month date)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  insert into public.tunnel_usage_batches (id) values (p_batch_id) on conflict do nothing;
  if not found then
    return false;
  end if;

  with counted as (
    select u.id, sum(u.bytes)::bigint as bytes, sum(u.requests)::bigint as requests
      from jsonb_to_recordset(coalesce(p_usage, '[]'::jsonb)) as u(id uuid, bytes bigint, requests bigint)
     where u.bytes >= 0 and u.requests >= 0
     group by u.id
  ), touched as (
    update public.tunnel_shares s
       set bytes = s.bytes + c.bytes,
           requests = s.requests + c.requests
      from counted c
     where s.id = c.id and s.kind = 'share'
    returning s.user_id, c.bytes, c.requests
  )
  insert into public.tunnel_usage as t (user_id, month, bytes, requests)
  select user_id, p_month, sum(bytes), sum(requests)
    from touched
   group by user_id
  on conflict (user_id, month) do update
    set bytes = t.bytes + excluded.bytes,
        requests = t.requests + excluded.requests;

  return true;
end;
$$;

revoke all on function public.tunnel_apply_usage_batch(text, jsonb, date) from public, anon, authenticated;
grant execute on function public.tunnel_apply_usage_batch(text, jsonb, date) to service_role;

-- Keeps a name for the account (in p_team_id when given) while it holds
-- fewer than p_limit. Answers 'ok', 'limit' or 'taken'.
create or replace function public.tunnel_reserve_name(
  p_user_id uuid,
  p_team_id uuid,
  p_name text,
  p_limit integer
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_held integer;
begin
  perform 1 from public.users where id = p_user_id for update;
  select count(*) into v_held from public.tunnel_names where user_id = p_user_id;
  if v_held >= p_limit then
    return 'limit';
  end if;
  insert into public.tunnel_names (name, user_id, team_id)
  values (p_name, p_user_id, p_team_id)
  on conflict (name) do nothing;
  if not found then
    return 'taken';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.tunnel_reserve_name(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.tunnel_reserve_name(uuid, uuid, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

-- Where a CLI connected from, 90 days after its run ended (a year when the run
-- was reported for child sexual abuse).
select cron.unschedule(jobid) from cron.job where jobname = 'tunnel-addresses-cleanup';
select cron.schedule(
  'tunnel-addresses-cleanup',
  '23 4 * * *',
  $$update public.tunnel_shares s
       set client_address = null
     where s.client_address is not null
       and s.ended_at < now() - interval '90 days'
       and not exists (
         select 1 from public.abuse_reports r
          where r.share_id = s.id and r.kind = 'csam'
            and r.created_at > now() - interval '365 days')$$
);

-- Batch ids, kept against the edge sending one twice; none comes back later
-- than two days.
select cron.unschedule(jobid) from cron.job where jobname = 'tunnel-usage-batches-cleanup';
select cron.schedule(
  'tunnel-usage-batches-cleanup',
  '17 * * * *',
  $$delete from public.tunnel_usage_batches where applied_at < now() - interval '2 days'$$
);

-- A live session an ended run left on its endpoint.
select cron.unschedule(jobid) from cron.job where jobname = 'tunnel-live-sessions-cleanup';
select cron.schedule(
  'tunnel-live-sessions-cleanup',
  '*/5 * * * *',
  $$update public.endpoints e
       set live_session_id = null
     where e.live_session_id is not null
       and not exists (
         select 1 from public.tunnel_shares s
          where s.id = e.live_session_id and s.ended_at is null)$$
);

commit;

-- Outside the transaction: endpoints is written on every capture.
create index concurrently if not exists endpoints_live_session
  on public.endpoints (live_session_id) where live_session_id is not null;

notify pgrst, 'reload schema';
