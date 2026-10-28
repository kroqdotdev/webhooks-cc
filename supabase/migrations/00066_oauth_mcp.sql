-- 00066: OAuth 2.1 for remote MCP clients (webhooks.cc/mcp).
--
-- A hosted agent (claude.ai, ChatGPT, a cloud coding agent) connects to the
-- remote MCP server with the authorization code flow and PKCE. The human
-- approves it once on /oauth/authorize while signed in. The grant is an
-- agent registration of kind 'oauth', claimed by that human at once: it is
-- listed under Connected agents, counts against the cap there, and is
-- disconnected the same way. Its access tokens are ordinary whcc_ rows in
-- api_keys, as for every agent registration; the refresh token belongs to
-- the registration and rotates on every use.
--
-- 1. agent_registrations: kind 'oauth', the client it was issued to, and the
--    refresh token (current and previous hash, for replay detection).
--    expires_at is when the refresh token stops working; each use moves it.
-- 2. oauth_clients: clients registered with Dynamic Client Registration
--    (RFC 7591). A Client ID Metadata Document needs no row.
-- 3. oauth_authorization_codes: single-use codes, hashed.
-- 4. redeem_oauth_code(): checks the code, its client, redirect URI and
--    PKCE challenge, uses it up, and creates the registration under the
--    user's row lock (the connected-agent cap, as complete_agent_claim()
--    does). A code presented twice revokes what the first use created
--    (RFC 6749 4.1.2).
-- 5. rotate_oauth_refresh(): the refresh grant. A refresh token presented
--    again moments after its rotation is a client retrying a lost response
--    (or refreshing twice in parallel): it gets a new pair, and the pair it
--    lost stops working. Later, it is a copy: the registration is revoked.
-- 6. revoke_oauth_refresh(): RFC 7009 for refresh tokens; the access tokens
--    of the grant go with it.
-- 7. cleanup_oauth(), hourly: old codes, OAuth registrations whose refresh
--    token ran out, and dynamically registered clients nobody uses.
--
-- Codes and tokens arrive hashed; nothing here sees a secret. Service role
-- only, like every other table and function of agent registration.
--
-- Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. OAuth registrations. agent_registrations holds a few thousand rows at
-- most, so the constraints are checked in place.
alter table public.agent_registrations
  drop constraint if exists agent_registrations_kind_check;
alter table public.agent_registrations
  add constraint agent_registrations_kind_check
  check (kind in ('anonymous', 'service_auth', 'identity_assertion', 'oauth'));

alter table public.agent_registrations
  add column if not exists oauth_client_id text
    check (char_length(oauth_client_id) <= 2048),
  add column if not exists oauth_refresh_hash text,
  add column if not exists oauth_previous_refresh_hash text,
  add column if not exists oauth_refreshed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_registrations_oauth_shape'
  ) then
    alter table public.agent_registrations
      add constraint agent_registrations_oauth_shape check (
        kind <> 'oauth'
        or (user_id is not null and claimed_at is not null and oauth_client_id is not null)
      );
  end if;
end
$$;

create unique index if not exists agent_registrations_oauth_refresh
  on public.agent_registrations (oauth_refresh_hash)
  where oauth_refresh_hash is not null;
create index if not exists agent_registrations_oauth_previous_refresh
  on public.agent_registrations (oauth_previous_refresh_hash)
  where oauth_previous_refresh_hash is not null;
-- The clients still in use, for the client cleanup below.
create index if not exists agent_registrations_oauth_client
  on public.agent_registrations (oauth_client_id)
  where oauth_client_id is not null;

-- 2. Dynamically registered clients.
create table if not exists public.oauth_clients (
  client_id     text primary key check (client_id ~ '^whoc_[A-Za-z0-9]{32}$'),
  -- Self-reported; shown to humans labelled as such.
  client_name   text check (char_length(client_name) <= 100),
  client_uri    text check (char_length(client_uri) <= 2048),
  redirect_uris text[] not null
                check (cardinality(redirect_uris) between 1 and 10
                       and char_length(array_to_string(redirect_uris, ' ')) <= 20480),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists oauth_clients_created
  on public.oauth_clients (created_at);

alter table public.oauth_clients enable row level security;
revoke all on table public.oauth_clients from public, anon, authenticated;

-- 3. Authorization codes.
create table if not exists public.oauth_authorization_codes (
  code_hash       text primary key,
  client_id       text not null check (char_length(client_id) <= 2048),
  client_name     text check (char_length(client_name) <= 100),
  user_id         uuid not null references public.users(id) on delete cascade,
  redirect_uri    text not null check (char_length(redirect_uri) <= 2048),
  -- S256 only: base64url of a SHA-256 digest.
  code_challenge  text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope           text not null check (char_length(scope) <= 200),
  resource        text check (char_length(resource) <= 2048),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  registration_id uuid references public.agent_registrations(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_user
  on public.oauth_authorization_codes (user_id);
create index if not exists oauth_authorization_codes_expires
  on public.oauth_authorization_codes (expires_at);
create index if not exists oauth_authorization_codes_registration
  on public.oauth_authorization_codes (registration_id)
  where registration_id is not null;

alter table public.oauth_authorization_codes enable row level security;
revoke all on table public.oauth_authorization_codes from public, anon, authenticated;

-- 4. Redeem a code: one transaction from the code to the registration.
create or replace function public.redeem_oauth_code(
  p_code_hash      text,
  p_client_id      text,
  p_redirect_uri   text,
  p_code_challenge text,
  p_refresh_hash   text,
  p_expires_at     timestamptz,
  p_max_agents     integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code      public.oauth_authorization_codes%rowtype;
  v_connected integer;
  v_id        uuid;
begin
  select * into v_code
    from public.oauth_authorization_codes
   where code_hash = p_code_hash
     for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_code.used_at is not null then
    -- A second use: whoever holds the code now may not be its client.
    if v_code.registration_id is not null then
      update public.agent_registrations
         set revoked_at = now()
       where id = v_code.registration_id
         and revoked_at is null;
      delete from public.api_keys where agent_registration_id = v_code.registration_id;
    end if;
    return jsonb_build_object('status', 'replayed');
  end if;

  -- Whatever happens next, the code is spent.
  update public.oauth_authorization_codes
     set used_at = now()
   where code_hash = p_code_hash;

  if v_code.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_code.client_id <> p_client_id
     or v_code.redirect_uri <> p_redirect_uri
     or v_code.code_challenge <> p_code_challenge then
    return jsonb_build_object('status', 'mismatch');
  end if;

  -- Serialize this user's connections so the cap below holds.
  perform 1 from public.users where id = v_code.user_id for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select count(*)
    into v_connected
    from public.agent_registrations
   where user_id = v_code.user_id
     and claimed_at is not null
     and revoked_at is null;
  if v_connected >= p_max_agents then
    return jsonb_build_object('status', 'too_many_agents');
  end if;

  insert into public.agent_registrations (
    kind, user_id, client_name, expires_at, claimed_at,
    oauth_client_id, oauth_refresh_hash, oauth_refreshed_at
  )
  values (
    'oauth', v_code.user_id, left(v_code.client_name, 64), p_expires_at, now(),
    v_code.client_id, p_refresh_hash, now()
  )
  returning id into v_id;

  update public.oauth_authorization_codes
     set registration_id = v_id
   where code_hash = p_code_hash;

  return jsonb_build_object(
    'status', 'ok',
    'registration_id', v_id,
    'user_id', v_code.user_id,
    'scope', v_code.scope,
    'resource', v_code.resource
  );
end;
$$;

revoke all on function public.redeem_oauth_code(text, text, text, text, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.redeem_oauth_code(text, text, text, text, text, timestamptz, integer)
  to service_role;

-- 5. Rotate a refresh token.
create or replace function public.rotate_oauth_refresh(
  p_refresh_hash  text,
  p_client_id     text,
  p_new_hash      text,
  p_expires_at    timestamptz,
  p_grace_seconds integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration public.agent_registrations%rowtype;
begin
  update public.agent_registrations
     set oauth_previous_refresh_hash = oauth_refresh_hash,
         oauth_refresh_hash = p_new_hash,
         oauth_refreshed_at = now(),
         expires_at = p_expires_at
   where oauth_refresh_hash = p_refresh_hash
     and kind = 'oauth'
     and oauth_client_id = p_client_id
     and revoked_at is null
     and expires_at > now()
  returning * into v_registration;
  if found then
    return jsonb_build_object(
      'status', 'ok',
      'registration_id', v_registration.id,
      'user_id', v_registration.user_id
    );
  end if;

  select * into v_registration
    from public.agent_registrations
   where oauth_previous_refresh_hash = p_refresh_hash
     and kind = 'oauth'
     and revoked_at is null
     for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_registration.oauth_refreshed_at > now() - make_interval(secs => p_grace_seconds)
     and v_registration.oauth_client_id = p_client_id
     and v_registration.expires_at > now() then
    update public.agent_registrations
       set oauth_refresh_hash = p_new_hash,
           expires_at = p_expires_at
     where id = v_registration.id;
    return jsonb_build_object(
      'status', 'ok',
      'registration_id', v_registration.id,
      'user_id', v_registration.user_id
    );
  end if;

  -- A rotated token came back: it was copied. End the grant for everyone.
  update public.agent_registrations
     set revoked_at = now()
   where id = v_registration.id;
  delete from public.api_keys where agent_registration_id = v_registration.id;
  return jsonb_build_object('status', 'replayed', 'registration_id', v_registration.id);
end;
$$;

revoke all on function public.rotate_oauth_refresh(text, text, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.rotate_oauth_refresh(text, text, text, timestamptz, integer)
  to service_role;

-- 6. Revoke a grant by its refresh token.
create or replace function public.revoke_oauth_refresh(p_refresh_hash text)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.agent_registrations
     set revoked_at = now()
   where oauth_refresh_hash = p_refresh_hash
     and kind = 'oauth'
     and revoked_at is null
  returning id into v_id;
  if v_id is not null then
    delete from public.api_keys where agent_registration_id = v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.revoke_oauth_refresh(text) from public, anon, authenticated;
grant execute on function public.revoke_oauth_refresh(text) to service_role;

-- 7. Cleanup.
create or replace function public.cleanup_oauth()
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  delete from public.oauth_authorization_codes
   where expires_at <= now() - interval '1 day';

  -- Nothing can use these any more; revoked ones go with
  -- cleanup_expired_agent_registrations() after seven days.
  delete from public.agent_registrations
   where kind = 'oauth'
     and revoked_at is null
     and expires_at <= now();

  delete from public.oauth_clients c
   where ((c.last_used_at is null and c.created_at <= now() - interval '1 day')
          or c.last_used_at <= now() - interval '90 days')
     and not exists (
       select 1
         from public.agent_registrations r
        where r.oauth_client_id = c.client_id
          and r.revoked_at is null
     );
end;
$$;

revoke all on function public.cleanup_oauth() from public, anon, authenticated;
grant execute on function public.cleanup_oauth() to service_role;

commit;

-- pg_cron 1.3+ already upserts named jobs; unscheduling first keeps a re-run
-- from ever leaving a duplicate.
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-oauth';
select cron.schedule(
  'cleanup-oauth',
  '23 * * * *',
  'select public.cleanup_oauth();'
);

notify pgrst, 'reload schema';
