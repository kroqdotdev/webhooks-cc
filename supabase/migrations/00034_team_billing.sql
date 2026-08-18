-- ============================================================================
-- Migration 00034: Team seat-based billing (Polar)
-- Part 1: schema. Teams get their own subscription + pooled quota state.
-- ============================================================================

alter table public.teams
  add column if not exists polar_customer_id     text,
  add column if not exists polar_subscription_id text,
  add column if not exists subscription_status   text
    check (subscription_status in ('active', 'canceled', 'past_due')),
  add column if not exists seats                 integer not null default 0,
  add column if not exists requests_used         bigint  not null default 0,
  add column if not exists request_limit         bigint  not null default 0,
  add column if not exists period_start          timestamptz,
  add column if not exists period_end            timestamptz,
  add column if not exists cancel_at_period_end  boolean not null default false;

create unique index if not exists teams_polar_customer
  on public.teams(polar_customer_id) where polar_customer_id is not null;
create unique index if not exists teams_polar_subscription
  on public.teams(polar_subscription_id) where polar_subscription_id is not null;
create index if not exists teams_period_end
  on public.teams(period_end) where subscription_status is not null;

alter table public.team_members
  add column if not exists polar_seat_id text;

-- public.requests is the hot capture path, so the team_id rollout must not
-- block writes: the FK is added NOT VALID (no table scan under the lock) and
-- validated separately, and the index is built concurrently. Each statement
-- must run outside a transaction block (psql autocommit, the documented way
-- these migrations are applied); CREATE INDEX CONCURRENTLY refuses to run
-- inside one.
alter table public.requests
  add column if not exists team_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'requests_team_id_fkey'
      and conrelid = 'public.requests'::regclass
  ) then
    alter table public.requests
      add constraint requests_team_id_fkey
      foreign key (team_id) references public.teams(id) on delete set null
      not valid;
  end if;
end $$;

alter table public.requests validate constraint requests_team_id_fkey;

-- An interrupted CREATE INDEX CONCURRENTLY leaves an invalid index behind, and
-- IF NOT EXISTS below would silently keep it. Drop it first so a retry of this
-- migration rebuilds a usable index. The plain DROP is metadata-only for an
-- invalid index and only ever runs in the retry path (DROP INDEX CONCURRENTLY
-- cannot run inside a DO block).
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'requests_team'
       and not i.indisvalid
  ) then
    execute 'drop index public.requests_team';
  end if;
end $$;

create index concurrently if not exists requests_team
  on public.requests(team_id) where team_id is not null;

-- ============================================================================
-- Part 2: pooled team quota in capture_webhook().
--
-- An endpoint shared into a team that carries a subscription bills that team's
-- pooled quota instead of the owner's personal quota, and the captured request
-- is stamped with the billed team. The oldest share wins, so moving an endpoint
-- between teams never silently re-routes billing.
--
-- Signature and result statuses are unchanged — the Rust receiver depends on
-- them. Base is the current function from 00024_signature_verification.sql;
-- only the owned-endpoint quota branch and the request insert differ.
-- ============================================================================

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
  p_body_raw    bytea default null
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
begin
  v_slug := p_slug;

  -- 1. Look up endpoint by slug (now includes signing fields)
  select id, user_id, is_ephemeral, expires_at, mock_response, response_rules,
         request_count, notification_url,
         signing_provider, signing_secret_encrypted, signing_header
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

  -- 3. Quota check (branching by endpoint type)
  if v_endpoint.is_ephemeral and v_endpoint.user_id is null then
    -- Ephemeral endpoint: atomic increment with 25-request cap
    select request_count into v_quota
      from public.check_and_increment_ephemeral(v_endpoint.id);

    if not found then
      return jsonb_build_object('status', 'quota_exceeded');
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

          return jsonb_build_object(
            'status', 'quota_exceeded',
            'retry_after', v_retry_after
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

      -- Free user with expired or unstarted period: start a new one
      if v_user.plan = 'free' and (v_user.period_end is null or v_user.period_end <= now()) then
        select remaining, quota_limit, period_end_ts into v_period
          from public.start_free_period(v_endpoint.user_id);

        if not found then
          return jsonb_build_object('status', 'quota_exceeded');
        end if;

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

        return jsonb_build_object(
          'status', 'quota_exceeded',
          'retry_after', v_retry_after
        );
      end if;
    end if;

  end if;
  -- else: owned endpoint with null user_id but not ephemeral — allow through (no quota)

  -- 4. Insert the request (capture generated ID for post-response verification)
  v_size := coalesce(octet_length(p_body_raw), octet_length(p_body), 0);

  insert into public.requests (
    endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at
  ) values (
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    perform public.increment_endpoint_request_count(v_endpoint.id, 1);
  end if;

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
    'signing_header', v_endpoint.signing_header
  );
end;
$$;

-- ============================================================================
-- Part 3: team lifecycle — seat-capped invite acceptance, team period resets,
-- and a retention carve-out for team-billed requests.
-- ============================================================================

-- Housekeeping for Part 2: 00019 added the 10-argument capture_webhook the Rust
-- receiver calls, but the 9-argument version from 00018 was never dropped. Two
-- live overloads make PostgREST report "Could not choose the best candidate
-- function" for any call that omits p_body_raw. Nothing calls the 9-arg form.
drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz
);

-- ----------------------------------------------------------------------------
-- accept_team_invite: seats are the member cap.
--
-- Base is 00022_accept_team_invite.sql. Two changes: the hardcoded 25-member
-- limit becomes the team's purchased seat count, and a team without a
-- subscription cannot seat anyone at all. Both rejections roll the invite back
-- to pending so it stays retryable once the owner buys seats. The new p_seat_id
-- carries the Polar seat assignment onto the membership row.
--
-- The signature changes (2 args -> 3), so the old overload must go: leaving it
-- would make PostgREST ambiguous for two-argument callers.
-- ----------------------------------------------------------------------------

drop function if exists public.accept_team_invite(uuid, uuid);

create or replace function public.accept_team_invite(
  p_user_id uuid,
  p_invite_id uuid,
  p_seat_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team_id uuid;
  v_team record;
  v_member_count integer;
begin
  -- Atomically claim the invite: pending → accepted, only if caller is the invited user
  update public.team_invites
  set status = 'accepted'
  where id = p_invite_id
    and invited_user_id = p_user_id
    and status = 'pending'
  returning team_id into v_team_id;

  if v_team_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Lock team row first to serialize concurrent accepts (even when no members exist yet)
  select id, seats, subscription_status into v_team
  from public.teams
  where id = v_team_id
  for update;

  if v_team.subscription_status is null then
    -- Roll back invite to pending so it can be accepted once the team subscribes
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'inactive');
  end if;

  -- Also lock existing memberships for this team
  perform 1 from public.team_members where team_id = v_team_id for update;

  select count(*) into v_member_count
  from public.team_members
  where team_id = v_team_id;

  if v_member_count >= v_team.seats then
    -- Roll back invite to pending so user can retry after seats are added
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'full');
  end if;

  -- Add as team member (ignore if already a member)
  insert into public.team_members (team_id, user_id, role, polar_seat_id)
  values (v_team_id, p_user_id, 'member', p_seat_id)
  on conflict (team_id, user_id) do nothing;

  return jsonb_build_object('status', 'accepted');
end;
$$;

-- Revoke public access, only service_role can call
revoke all on function public.accept_team_invite(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_team_invite(uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- process_billing_period_resets: teams renew and lapse like personal Pro.
--
-- Base is 00005_billing_period_resets.sql; the two user CTEs are unchanged. Two
-- team CTEs follow them, in the same order and with the same predicates: a team
-- that canceled at period end is deactivated (counted as downgraded), and every
-- other active team rolls into a fresh 30-day period (counted as renewed).
-- Return shape is unchanged — the pg_cron job and lib/supabase/billing.ts both
-- depend on it.
-- ----------------------------------------------------------------------------

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
      polar_subscription_id = null
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
      period_end = null
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

  return query
  select downgraded_count + renewed_count, downgraded_count, renewed_count;
end;
$$;

-- `create or replace` preserves the pre-existing ACL, and this function predates
-- the hardening pass — it still carried the anon/authenticated EXECUTE that
-- Supabase's default privileges hand to every new function in `public`. Same
-- treatment 00025_harden_cleanup_rpc.sql applied to the ephemeral cleanup RPC.
-- Both callers are unaffected: pg_cron runs as postgres, and lib/supabase/
-- billing.ts calls it through the service-role client.
revoke all on function public.process_billing_period_resets() from public;
revoke all on function public.process_billing_period_resets() from anon;
revoke all on function public.process_billing_period_resets() from authenticated;
grant execute on function public.process_billing_period_resets() to service_role;

-- ----------------------------------------------------------------------------
-- cleanup_free_user_requests: 7-day retention is a personal-plan limit.
--
-- Base is 00001_initial_schema.sql; only the delete predicate changes. A request
-- billed to a team was paid for by that team's subscription, so the owner's
-- personal plan must not decide how long it is kept.
-- ----------------------------------------------------------------------------

create or replace function public.cleanup_free_user_requests()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.requests
  where user_id in (select id from public.users where plan = 'free')
    and team_id is null
    and received_at < now() - interval '7 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Same hardening, and more urgent here: this is a security definer function
-- whose DELETE is not scoped to any caller, so an anon EXECUTE grant let anyone
-- holding the published anon key destroy every free-tier user's request history
-- over PostgREST. Its only caller is the daily pg_cron job, which runs as postgres.
revoke all on function public.cleanup_free_user_requests() from public;
revoke all on function public.cleanup_free_user_requests() from anon;
revoke all on function public.cleanup_free_user_requests() from authenticated;
grant execute on function public.cleanup_free_user_requests() to service_role;

-- ============================================================================
-- Part 4: search retention carve-out.
--
-- Base is 00021_search_index_compat.sql; the only change is the retention
-- conjunct, which now lets a team-billed row through. Search must agree with
-- the read path in lib/supabase/requests.ts and with which rows
-- cleanup_free_user_requests() actually deletes, or a free owner sees a
-- team-billed request in the dashboard but cannot find it by searching.
--
-- Both functions are `security definer` over an arbitrary p_user_id, so anon or
-- authenticated execute is a full read of every user's captured headers and
-- bodies. `create or replace` preserves the pre-existing (over-broad) ACL, so
-- the revoke/grant stanzas below are re-issued after the definitions.
-- ============================================================================

create or replace function public.search_requests(
  p_user_id uuid,
  p_plan text default null,
  p_slug text default null,
  p_method text default null,
  p_q text default null,
  p_from_ms bigint default null,
  p_to_ms bigint default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_order text default 'desc'
)
returns table(
  id text,
  slug text,
  method text,
  path text,
  headers jsonb,
  body text,
  query_params jsonb,
  content_type text,
  ip text,
  size integer,
  received_at bigint
)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_plan text := coalesce(p_plan, 'pro');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_order text := case when lower(coalesce(p_order, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_from timestamptz := case
    when p_from_ms is null then null
    else to_timestamp(p_from_ms::double precision / 1000.0)
  end;
  v_to timestamptz := case
    when p_to_ms is null then null
    else to_timestamp(p_to_ms::double precision / 1000.0)
  end;
  v_retention_cutoff timestamptz := case
    when v_plan = 'free' then now() - interval '7 days'
    else null
  end;
  v_q text := nullif(btrim(p_q), '');
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  return query execute format(
    'select
       r.id::text,
       e.slug,
       r.method,
       r.path,
       r.headers,
       nullif(r.body, ''''),
       r.query_params,
       nullif(r.content_type, ''''),
       r.ip,
       r.size,
       floor(extract(epoch from r.received_at) * 1000)::bigint
     from public.requests r
     join public.endpoints e on e.id = r.endpoint_id
     where r.user_id = $1
       and ($2 is null or e.slug = $2)
       and ($3 is null or $3 = ''ALL'' or r.method = $3)
       and (
         $4 is null
         or r.path ilike ''%%'' || $4 || ''%%''
         or r.body ilike ''%%'' || $4 || ''%%''
         or r.headers::text ilike ''%%'' || $4 || ''%%''
       )
       and ($5 is null or r.received_at >= $5)
       and ($6 is null or r.received_at <= $6)
       and ($7 is null or r.team_id is not null or r.received_at >= $7)
     order by r.received_at %s
     limit %s offset %s',
    v_order,
    v_limit,
    v_offset
  )
  using p_user_id, nullif(btrim(p_slug), ''), nullif(btrim(p_method), ''), v_q, v_from, v_to, v_retention_cutoff;
end;
$$;

-- Same one-conjunct change, so the result count matches the result page.
create or replace function public.search_requests_count(
  p_user_id uuid,
  p_plan text default null,
  p_slug text default null,
  p_method text default null,
  p_q text default null,
  p_from_ms bigint default null,
  p_to_ms bigint default null
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_plan text := coalesce(p_plan, 'pro');
  v_from timestamptz := case
    when p_from_ms is null then null
    else to_timestamp(p_from_ms::double precision / 1000.0)
  end;
  v_to timestamptz := case
    when p_to_ms is null then null
    else to_timestamp(p_to_ms::double precision / 1000.0)
  end;
  v_retention_cutoff timestamptz := case
    when v_plan = 'free' then now() - interval '7 days'
    else null
  end;
  v_q text := nullif(btrim(p_q), '');
  v_count integer;
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select count(*)::integer
  into v_count
  from public.requests r
  join public.endpoints e on e.id = r.endpoint_id
  where r.user_id = p_user_id
    and (nullif(btrim(p_slug), '') is null or e.slug = nullif(btrim(p_slug), ''))
    and (nullif(btrim(p_method), '') is null or nullif(btrim(p_method), '') = 'ALL' or r.method = nullif(btrim(p_method), ''))
    and (
      v_q is null
      or r.path ilike '%' || v_q || '%'
      or r.body ilike '%' || v_q || '%'
      or r.headers::text ilike '%' || v_q || '%'
    )
    and (v_from is null or r.received_at >= v_from)
    and (v_to is null or r.received_at <= v_to)
    and (v_retention_cutoff is null or r.team_id is not null or r.received_at >= v_retention_cutoff);

  return coalesce(v_count, 0);
end;
$$;

-- Keep both search RPCs service-role only. `create or replace` above preserves
-- whatever ACL the function already had, so these must be re-issued here or a
-- stale anon/authenticated grant survives the migration. Every caller goes
-- through createAdminClient() in lib/supabase/search.ts.
revoke all on function public.search_requests(
  uuid, text, text, text, text, bigint, bigint, integer, integer, text
) from public;
revoke all on function public.search_requests(
  uuid, text, text, text, text, bigint, bigint, integer, integer, text
) from anon;
revoke all on function public.search_requests(
  uuid, text, text, text, text, bigint, bigint, integer, integer, text
) from authenticated;
grant execute on function public.search_requests(
  uuid, text, text, text, text, bigint, bigint, integer, integer, text
) to service_role;

revoke all on function public.search_requests_count(
  uuid, text, text, text, text, bigint, bigint
) from public;
revoke all on function public.search_requests_count(
  uuid, text, text, text, text, bigint, bigint
) from anon;
revoke all on function public.search_requests_count(
  uuid, text, text, text, text, bigint, bigint
) from authenticated;
grant execute on function public.search_requests_count(
  uuid, text, text, text, text, bigint, bigint
) to service_role;

-- Reload PostgREST schema cache so the Part 1 columns are visible via REST API
notify pgrst, 'reload schema';
