-- ============================================================================
-- Migration 00044: capture under load
--
-- Measured locally (issue #434): one account receiving many concurrent
-- webhooks serialized on its quota row while holding receiver connections,
-- and the trigram search indexes multiplied the write cost of every capture.
--
--  1. Search indexes. requests_body_trgm, requests_headers_text_trgm and
--     requests_path_trgm made each capture write about 28 kB of WAL instead of
--     about 3.4 kB, and cost about a third of capture throughput, while
--     searches are rare. They are dropped. Searches that name a slug now read
--     only that endpoint's rows through requests_endpoint_time; account-wide
--     searches for rare terms fall back to scanning the account's retained
--     rows (measured 0.3 to 1 s at 100k rows).
--
--  2. capture_webhook() returns billing_key ('user:<id>', 'team:<id>', or
--     'endpoint:<id>' for guest endpoints): the row the capture's quota lands
--     on. The receiver caps concurrent captures per key, so one busy account
--     queues on its own row lock without taking every pooled connection.
--     capture_billing_key() returns the same key without capturing, for slugs
--     the receiver has not seen yet.
--
--  3. Free-period race. Concurrent first captures of a free period (the first
--     ones ever, and every daily rollover) all called start_free_period(); one
--     started the period and the rest found no row once its lock was released
--     and answered quota_exceeded, a spurious 429. They now carry on with the
--     period that was started. start_free_period() also accepts a period that
--     ends exactly now, matching the check in capture_webhook().
--
-- Run outside a transaction (plain psql autocommit): DROP INDEX CONCURRENTLY
-- cannot run inside one.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Free periods
-- ----------------------------------------------------------------------------

create or replace function public.start_free_period(p_user_id uuid)
returns table(remaining integer, quota_limit integer, period_end_ts timestamptz)
language plpgsql
security definer set search_path = ''
as $$
begin
  return query
  update public.users
  set
    period_start = now(),
    period_end = now() + interval '24 hours',
    requests_used = 0
  where id = p_user_id
    and plan = 'free'
    and (period_end is null or period_end <= now())
  returning
    request_limit as remaining,
    request_limit as quota_limit,
    public.users.period_end as period_end_ts;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. capture_webhook: billing_key and the free-period race
-- ----------------------------------------------------------------------------

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
  v_day             date;
  -- The row this capture's quota lands on; returned so the receiver can cap
  -- concurrent captures per account.
  v_billing_key     text;
begin
  v_slug := p_slug;
  v_day := (coalesce(p_received_at, now()) at time zone 'UTC')::date;

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
    v_billing_key := 'endpoint:' || v_endpoint.id::text;
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
    end if;

  end if;
  -- else: owned endpoint with null user_id but not ephemeral: allow through (no quota)

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

  perform public.bump_endpoint_daily_stats(
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, v_day,
    1, (v_billing_team_id is not null)::integer, 0, v_size
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
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) to service_role;

-- The billing key capture_webhook() would return for a slug, without capturing:
-- the receiver asks before the first capture of a slug it has not cached, so a
-- burst across fresh slugs of one account shares the account's cap. Mirrors the
-- billing selection in capture_webhook(); keep the two in step.
create or replace function public.capture_billing_key(p_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
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

-- ----------------------------------------------------------------------------
-- 3. Slug-scoped search
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.search_requests(p_user_id uuid, p_plan text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_method text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_from_ms bigint DEFAULT NULL::bigint, p_to_ms bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_order text DEFAULT 'desc'::text)
 RETURNS TABLE(id text, slug text, method text, path text, headers jsonb, body text, query_params jsonb, content_type text, ip text, size integer, received_at bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
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
  v_free_cutoff timestamptz := now() - interval '7 days';
  v_q text := nullif(btrim(p_q), '');
  -- Endpoints shared with the caller through a subscribed team. Resolved once
  -- so the shared branch is a plain `endpoint_id = any(...)` index probe.
  v_shared_ids uuid[];
  -- The endpoint a slug names, so slug-scoped searches walk only its rows
  -- through requests_endpoint_time instead of every row the caller can see.
  v_endpoint_id uuid;
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct te.endpoint_id), '{}'::uuid[])
  into v_shared_ids
  from public.team_endpoints te
  join public.team_members tm on tm.team_id = te.team_id
  join public.teams t on t.id = te.team_id
  where tm.user_id = p_user_id
    and t.subscription_status is not null;

  if nullif(btrim(p_slug), '') is not null then
    select e.id into v_endpoint_id
      from public.endpoints e
     where e.slug = nullif(btrim(p_slug), '');
    if v_endpoint_id is null then
      return;
    end if;
  end if;

  return query execute format(
    'with owned as (
       select r.id, e.slug, r.method, r.path, r.headers, r.body, r.query_params,
              r.content_type, r.ip, r.size, r.received_at
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       where r.user_id = $1
         and ($10 is null or r.endpoint_id = $10)
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
       order by r.received_at %1$s
       limit %2$s
     ),
     shared as (
       select r.id, e.slug, r.method, r.path, r.headers, r.body, r.query_params,
              r.content_type, r.ip, r.size, r.received_at
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       left join public.users u on u.id = e.user_id
       where r.endpoint_id = any($8)
         and ($10 is null or r.endpoint_id = $10)
         and r.user_id is distinct from $1
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
         and (r.team_id is not null or u.plan is distinct from ''free'' or r.received_at >= $9)
       order by r.received_at %1$s
       limit %2$s
     )
     select x.id::text, x.slug, x.method, x.path, x.headers,
            nullif(x.body, ''''), x.query_params, nullif(x.content_type, ''''),
            x.ip, x.size,
            floor(extract(epoch from x.received_at) * 1000)::bigint
     from (select * from owned union all select * from shared) x
     order by x.received_at %1$s
     limit %3$s offset %4$s',
    v_order,
    v_limit + v_offset,
    v_limit,
    v_offset
  )
  using p_user_id, nullif(btrim(p_slug), ''), nullif(btrim(p_method), ''), v_q, v_from, v_to,
        v_retention_cutoff, v_shared_ids, v_free_cutoff, v_endpoint_id;
end;
$$;

CREATE OR REPLACE FUNCTION public.search_requests_count(p_user_id uuid, p_plan text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_method text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_from_ms bigint DEFAULT NULL::bigint, p_to_ms bigint DEFAULT NULL::bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_plan text := coalesce(p_plan, 'pro');
  v_slug text := nullif(btrim(p_slug), '');
  v_method text := nullif(btrim(p_method), '');
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
  v_free_cutoff timestamptz := now() - interval '7 days';
  v_q text := nullif(btrim(p_q), '');
  v_shared_ids uuid[];
  v_owned integer;
  v_shared integer;
  v_endpoint_id uuid;
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct te.endpoint_id), '{}'::uuid[])
  into v_shared_ids
  from public.team_endpoints te
  join public.team_members tm on tm.team_id = te.team_id
  join public.teams t on t.id = te.team_id
  where tm.user_id = p_user_id
    and t.subscription_status is not null;

  -- Slug-scoped counts read only that endpoint's rows. Static statements in
  -- PL/pgSQL may run on a cached generic plan, where an "id is null or ..."
  -- guard would not use the index, so the scoped count is its own branch.
  if v_slug is not null then
    select e.id into v_endpoint_id from public.endpoints e where e.slug = v_slug;
    if v_endpoint_id is null then
      return 0;
    end if;

    select count(*)::integer
    into v_owned
    from public.requests r
    left join public.endpoints e on e.id = r.endpoint_id
    left join public.users u on u.id = e.user_id
    where r.endpoint_id = v_endpoint_id
      and (
        (r.user_id = p_user_id
          and (v_retention_cutoff is null or r.team_id is not null or r.received_at >= v_retention_cutoff))
        or (v_endpoint_id = any(v_shared_ids)
          and r.user_id is distinct from p_user_id
          and (r.team_id is not null or u.plan is distinct from 'free' or r.received_at >= v_free_cutoff))
      )
      and (v_method is null or v_method = 'ALL' or r.method = v_method)
      and (
        v_q is null
        or r.path ilike '%' || v_q || '%'
        or r.body ilike '%' || v_q || '%'
        or r.headers::text ilike '%' || v_q || '%'
      )
      and (v_from is null or r.received_at >= v_from)
      and (v_to is null or r.received_at <= v_to);

    return coalesce(v_owned, 0);
  end if;

  select count(*)::integer
  into v_owned
  from public.requests r
  join public.endpoints e on e.id = r.endpoint_id
  where r.user_id = p_user_id
    and (v_slug is null or e.slug = v_slug)
    and (v_method is null or v_method = 'ALL' or r.method = v_method)
    and (
      v_q is null
      or r.path ilike '%' || v_q || '%'
      or r.body ilike '%' || v_q || '%'
      or r.headers::text ilike '%' || v_q || '%'
    )
    and (v_from is null or r.received_at >= v_from)
    and (v_to is null or r.received_at <= v_to)
    and (v_retention_cutoff is null or r.team_id is not null or r.received_at >= v_retention_cutoff);

  select count(*)::integer
  into v_shared
  from public.requests r
  join public.endpoints e on e.id = r.endpoint_id
  left join public.users u on u.id = e.user_id
  where r.endpoint_id = any(v_shared_ids)
    and r.user_id is distinct from p_user_id
    and (v_slug is null or e.slug = v_slug)
    and (v_method is null or v_method = 'ALL' or r.method = v_method)
    and (
      v_q is null
      or r.path ilike '%' || v_q || '%'
      or r.body ilike '%' || v_q || '%'
      or r.headers::text ilike '%' || v_q || '%'
    )
    and (v_from is null or r.received_at >= v_from)
    and (v_to is null or r.received_at <= v_to)
    and (r.team_id is not null or u.plan is distinct from 'free' or r.received_at >= v_free_cutoff);

  return coalesce(v_owned, 0) + coalesce(v_shared, 0);
end;
$$;

revoke all on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) to service_role;

revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) to service_role;

-- ----------------------------------------------------------------------------
-- 4. Drop the trigram search indexes
-- ----------------------------------------------------------------------------

drop index concurrently if exists public.requests_body_trgm;
drop index concurrently if exists public.requests_headers_text_trgm;
drop index concurrently if exists public.requests_path_trgm;

notify pgrst, 'reload schema';
