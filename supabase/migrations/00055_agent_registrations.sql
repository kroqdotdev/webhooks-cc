-- 00055: agent registrations (auth.md v0.6) and the agent sandbox.
--
-- auth.md v0.2 and later never hand out a credential at registration. An
-- agent registers at /api/agent/identity and gets a signed identity
-- assertion, which it exchanges at /api/oauth2/token for a short-lived
-- access token. Everything an agent holds hangs off one registration row.
--
-- 1. agent_registrations: one row per registration of any kind. An
--    unclaimed one lives 24 hours (expires_at); a claimed one (user_id and
--    claimed_at set) until it is revoked or its user is deleted. The claim
--    attempt columns are used by the claim ceremony (next migration). The
--    proof-of-work challenge id is unique, which makes a challenge single
--    use for as long as the row exists, far longer than a challenge lives.
-- 2. api_keys.agent_registration_id: access tokens are ordinary whcc_ keys
--    tied to their registration, with an expiry, so the bearer path and
--    every route accept them unchanged. Deleting the registration deletes
--    them.
-- 3. endpoints.agent_registration_id: sandbox endpoints belong to their
--    registration, never to a user, and expire with it. They are not guest
--    endpoints: guest reads and the guest claim skip them, and they count
--    against their own pool.
-- 4. create_sandbox_endpoint(): the per-registration cap and the pool cap
--    are checked and the row inserted under one lock, so concurrent creates
--    cannot overshoot either.
-- 5. capture_webhook(): a sandbox capture also spends one unit of its
--    registration's budget (100 by default) before the existing 25-request
--    cap per endpoint. Guest and owned captures do not reach the new code.
--    Otherwise the body is 00050's.
-- 6. capture_billing_key(): 'agent:<registration id>' for sandbox endpoints,
--    so the receiver's per-account capture limit covers a registration's
--    endpoints together. capture_webhook() returns the same key.
-- 7. cleanup_expired_agent_registrations(), every 10 minutes: deletes
--    unclaimed registrations past their expiry (with their tokens and
--    endpoints) and revoked ones after 7 days, and expired agent tokens.
-- 8. revoke_all_unclaimed_agent_registrations(): the operator's switch for
--    an incident.
--
-- Service role only, like every other table and function here.
--
-- Apply in autocommit mode (see AGENTS.md): the indexes on api_keys and
-- endpoints are built concurrently, outside any transaction block.

-- 1. Registrations. The table is new, so its indexes are built in place.
begin;

create table if not exists public.agent_registrations (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text not null
                           check (kind in ('anonymous', 'service_auth', 'identity_assertion')),
  user_id                uuid references public.users(id) on delete cascade,
  -- Self-reported by the agent; shown to humans labelled as such.
  client_name            text check (char_length(client_name) <= 64),
  claim_token_hash       text unique,
  expires_at             timestamptz not null,
  claimed_at             timestamptz,
  claim_consumed_at      timestamptz,
  revoked_at             timestamptz,
  pow_challenge_id       text unique check (char_length(pow_challenge_id) <= 64),
  sandbox_requests_used  integer not null default 0 check (sandbox_requests_used >= 0),
  sandbox_request_limit  integer not null default 100 check (sandbox_request_limit >= 0),
  -- The current claim attempt; a new attempt replaces it.
  attempt_token_hash     text unique,
  attempt_user_code_hash text,
  attempt_login_hint     text check (char_length(attempt_login_hint) <= 254),
  attempt_expires_at     timestamptz,
  attempt_failures       integer not null default 0,
  attempts_issued        integer not null default 0,
  attempt_denied_at      timestamptz,
  idjag_iss              text,
  idjag_sub              text,
  created_at             timestamptz not null default now(),
  constraint agent_registrations_claimed_has_user
    check (user_id is not null or claimed_at is null),
  constraint agent_registrations_idjag_identity
    check (kind <> 'identity_assertion' or (idjag_iss is not null and idjag_sub is not null))
);

-- Live and expired unclaimed registrations: the live-count cap and cleanup.
create index if not exists agent_registrations_unclaimed_expires
  on public.agent_registrations (expires_at)
  where claimed_at is null;
-- A user's connected agents, and the cascade when a user is deleted.
create index if not exists agent_registrations_user
  on public.agent_registrations (user_id)
  where user_id is not null;
create index if not exists agent_registrations_revoked
  on public.agent_registrations (revoked_at)
  where revoked_at is not null;
-- One live registration per ID-JAG identity.
create unique index if not exists agent_registrations_idjag
  on public.agent_registrations (idjag_iss, idjag_sub)
  where idjag_iss is not null and revoked_at is null;

alter table public.agent_registrations enable row level security;
revoke all on table public.agent_registrations from public, anon, authenticated;

commit;

-- 2. Access tokens. A nullable column without a default is a catalog-only
-- change; the foreign key and the check are added NOT VALID and validated
-- afterwards, which does not block writes.
alter table public.api_keys add column if not exists agent_registration_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_keys_agent_registration_id_fkey'
  ) then
    alter table public.api_keys
      add constraint api_keys_agent_registration_id_fkey
      foreign key (agent_registration_id)
      references public.agent_registrations(id) on delete cascade
      not valid;
  end if;
  -- Agent tokens always expire and are always marked agent-issued.
  if not exists (
    select 1 from pg_constraint where conname = 'api_keys_agent_token_shape'
  ) then
    alter table public.api_keys
      add constraint api_keys_agent_token_shape check (
        agent_registration_id is null or (is_agent_issued and expires_at is not null)
      ) not valid;
  end if;
end
$$;
alter table public.api_keys validate constraint api_keys_agent_registration_id_fkey;
alter table public.api_keys validate constraint api_keys_agent_token_shape;

-- A registration's tokens, oldest first: the live-token cap and the cascade.
create index concurrently if not exists api_keys_agent_registration
  on public.api_keys (agent_registration_id, created_at)
  where agent_registration_id is not null;

-- 3. Sandbox endpoints.
alter table public.endpoints add column if not exists agent_registration_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'endpoints_agent_registration_id_fkey'
  ) then
    alter table public.endpoints
      add constraint endpoints_agent_registration_id_fkey
      foreign key (agent_registration_id)
      references public.agent_registrations(id) on delete cascade
      not valid;
  end if;
  -- A sandbox endpoint has no owner, is ephemeral and expires.
  if not exists (
    select 1 from pg_constraint where conname = 'endpoints_sandbox_shape'
  ) then
    alter table public.endpoints
      add constraint endpoints_sandbox_shape check (
        agent_registration_id is null
        or (user_id is null and is_ephemeral and expires_at is not null)
      ) not valid;
  end if;
end
$$;
alter table public.endpoints validate constraint endpoints_agent_registration_id_fkey;
alter table public.endpoints validate constraint endpoints_sandbox_shape;

-- Holds sandbox rows only (a few hundred at most): a registration's
-- endpoints, the pool count, and the cascade.
create index concurrently if not exists endpoints_agent_registration
  on public.endpoints (agent_registration_id, expires_at)
  where agent_registration_id is not null;

begin;

-- 4. Create a sandbox endpoint for a live, unclaimed anonymous registration.
-- Answers status 'ok' with the new id, or 'registration_inactive',
-- 'endpoint_limit' or 'pool_full'. A slug collision raises 23505, and the
-- caller retries with another slug.
create or replace function public.create_sandbox_endpoint(
  p_registration_id uuid,
  p_slug            text,
  p_max_endpoints   integer,
  p_pool_size       integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration record;
  v_live         integer;
  v_pool         integer;
  v_endpoint_id  uuid;
begin
  -- Creates take turns: both counts below must still hold at the insert.
  perform pg_advisory_xact_lock(hashtextextended('public.create_sandbox_endpoint', 0));

  -- FOR SHARE so a claim, which locks the row for update, waits for this
  -- create and then adopts the new endpoint with the others.
  select id, expires_at
    into v_registration
    from public.agent_registrations
   where id = p_registration_id
     and kind = 'anonymous'
     and claimed_at is null
     and revoked_at is null
     and expires_at > now()
     for share;

  if not found then
    return jsonb_build_object('status', 'registration_inactive');
  end if;

  select count(*) into v_live
    from public.endpoints
   where agent_registration_id = p_registration_id
     and expires_at > now();

  if v_live >= p_max_endpoints then
    return jsonb_build_object('status', 'endpoint_limit', 'limit', p_max_endpoints);
  end if;

  select count(*) into v_pool
    from public.endpoints
   where agent_registration_id is not null
     and expires_at > now();

  if v_pool >= p_pool_size then
    return jsonb_build_object('status', 'pool_full');
  end if;

  insert into public.endpoints (slug, user_id, is_ephemeral, expires_at, agent_registration_id)
  values (p_slug, null, true, v_registration.expires_at, p_registration_id)
  returning id into v_endpoint_id;

  return jsonb_build_object('status', 'ok', 'id', v_endpoint_id);
end;
$$;

revoke all on function public.create_sandbox_endpoint(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_sandbox_endpoint(uuid, text, integer, integer)
  to service_role;

-- 5. capture_webhook(): 00050's body, with the endpoint lookup reading
-- agent_registration_id and the sandbox budget in step 3.
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
  p_size        integer default null
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
begin
  v_slug := p_slug;
  v_kind := coalesce(p_kind, 'http');
  if v_kind not in ('http', 'email') then
    raise exception 'invalid capture kind: %', v_kind using errcode = '22023';
  end if;
  v_day := (coalesce(p_received_at, now()) at time zone 'UTC')::date;

  -- 1. Look up endpoint by slug (now includes signing fields)
  select id, user_id, is_ephemeral, expires_at, mock_response, response_rules,
         request_count, notification_url,
         signing_provider, signing_secret_encrypted, signing_header,
         forward_enabled, agent_registration_id
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
    select t.id, t.period_end
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
         and requests_used < request_limit;

      if found then
        v_billing_team_id := v_team.id;
      else
        -- No row updated: pool exhausted, or the team deactivated since the
        -- select. Only a still-active team may answer quota_exceeded; a
        -- deactivated one falls through to the owner's personal quota below.
        perform 1 from public.teams
         where id = v_team.id
           and subscription_status is not null;

        if found then
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
      select id, plan, request_limit, requests_used, period_end
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
        select id, plan, request_limit, requests_used, period_end
          into v_user
          from public.users
         where id = v_endpoint.user_id;
      end if;

      -- Atomic quota check + decrement
      select remaining, quota_limit, period_end_ts into v_quota
        from public.check_and_decrement_quota(v_endpoint.user_id, 1);

      if not found then
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
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key
  ) values (
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    perform public.increment_endpoint_request_count(v_endpoint.id, 1);
  end if;

  -- 5b. Forwarding: queue the delivery in the capture's own transaction, so
  -- a captured email is never lost before it is queued; the web app's worker
  -- sends it (claim_email_deliveries). Step 5 holds the endpoint row (email
  -- always has an owner), so forward_enabled is read again under that lock:
  -- turning forwarding off either committed first and is seen here, or waits
  -- for this capture and then settles the queued row with the others.
  if v_kind = 'email' and v_endpoint.forward_enabled then
    if (select e.forward_enabled from public.endpoints e where e.id = v_endpoint.id) then
      insert into public.email_deliveries (request_id, endpoint_id)
      values (v_request_id, v_endpoint.id);
    end if;
  end if;

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
    'notification_url', v_endpoint.notification_url,
    'signing_provider', v_endpoint.signing_provider,
    'signing_secret_encrypted', encode(v_endpoint.signing_secret_encrypted, 'base64'),
    'signing_header', v_endpoint.signing_header,
    'billing_key', v_billing_key
  );
end;
$$;

revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer
) to service_role;

-- 6. The receiver's per-account key, without capturing. Mirrors the keys
-- capture_webhook() returns; change them together.
create or replace function public.capture_billing_key(p_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when e.agent_registration_id is not null then 'agent:' || e.agent_registration_id::text
    when e.is_ephemeral and e.user_id is null then 'endpoint:' || e.id::text
    when e.user_id is null then null
    else coalesce(
      (select 'team:' || t.id::text
         from public.team_endpoints te
         join public.teams t on t.id = te.team_id
        where te.endpoint_id = e.id
          and t.subscription_status is not null
        order by te.shared_at asc
        limit 1),
      'user:' || e.user_id::text
    )
  end
  from public.endpoints e
  where e.slug = p_slug;
$$;

revoke all on function public.capture_billing_key(text) from public, anon, authenticated;
grant execute on function public.capture_billing_key(text) to service_role;

-- 7. Cleanup. Deleting a registration deletes its tokens and endpoints (and
-- through them their requests; the 00038 trigger keeps the site totals).
-- Each unclaimed registration that ran out leaves one audit row.
create or replace function public.cleanup_expired_agent_registrations()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.api_keys
   where agent_registration_id is not null
     and expires_at <= now();

  with gone as (
    delete from public.agent_registrations
     where (claimed_at is null and expires_at <= now())
        or (revoked_at is not null and revoked_at <= now() - interval '7 days')
    returning id, kind, claimed_at, revoked_at
  ),
  audited as (
    insert into public.audit_events (actor_type, action, outcome, target_id, metadata)
    select 'system', 'agent.registration.expired', 'ok', g.id::text,
           jsonb_build_object('kind', g.kind)
      from gone g
     where g.claimed_at is null
       and g.revoked_at is null
    returning 1
  )
  select count(*) into v_deleted from gone;

  return v_deleted;
end;
$$;

revoke all on function public.cleanup_expired_agent_registrations()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_agent_registrations() to service_role;

-- 8. Incident switch: revoke every live unclaimed registration at once.
-- Their tokens and sandbox endpoints go immediately, which also empties the
-- pool; the rows stay 7 days for the record.
create or replace function public.revoke_all_unclaimed_agent_registrations()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_revoked integer;
begin
  with revoked as (
    update public.agent_registrations
       set revoked_at = now()
     where claimed_at is null
       and revoked_at is null
       and expires_at > now()
    returning id, kind
  ),
  tokens as (
    delete from public.api_keys
     where agent_registration_id in (select id from revoked)
    returning 1
  ),
  sandbox as (
    delete from public.endpoints
     where agent_registration_id in (select id from revoked)
    returning 1
  ),
  audited as (
    insert into public.audit_events (actor_type, action, outcome, target_id, metadata)
    select 'system', 'agent.registration.revoked', 'ok', r.id::text,
           jsonb_build_object('kind', r.kind, 'reason', 'revoke_all_unclaimed')
      from revoked r
    returning 1
  )
  select count(*) into v_revoked from revoked;

  return v_revoked;
end;
$$;

revoke all on function public.revoke_all_unclaimed_agent_registrations()
  from public, anon, authenticated;
grant execute on function public.revoke_all_unclaimed_agent_registrations() to service_role;

commit;

-- pg_cron 1.3+ already upserts named jobs; unscheduling first keeps a re-run
-- from ever leaving a duplicate.
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-expired-agent-registrations';
select cron.schedule(
  'cleanup-expired-agent-registrations',
  '*/10 * * * *',
  'select public.cleanup_expired_agent_registrations();'
);

notify pgrst, 'reload schema';
