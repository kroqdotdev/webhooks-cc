-- 00049: email capture dashboard (phase 3).
--
-- 1. endpoints.show_email_extracts: per-endpoint switch for the dashboard's
--    "Found in this email" strip (codes and links). On by default.
-- 2. endpoint_daily_stats.emails: emails captured per endpoint and day, a
--    count that outlives request retention and deletion like the others in
--    that table. Backfilled in step 6 for email captured since 00048.
-- 3. bump_endpoint_daily_stats() gains p_emails (default 0) and
--    capture_webhook() passes it. capture_webhook() also keeps step 5's
--    counter for emails billed to the user; otherwise it is unchanged from
--    00048.
-- 4. search_requests() returns kind, email and body_raw too, and both it and
--    search_requests_count() take p_kind to filter by kind (see below).
-- 5. users.emails_used and users.emails_period_start: emails billed to the
--    user in the current period, for the usage split (see step 3).
-- 6. Backfills for step 2 and step 5.
--
-- Apply in autocommit mode (see AGENTS.md); the function swap below runs in
-- one transaction so no capture ever sees the old bump function missing.

alter table public.endpoints
  add column if not exists show_email_extracts boolean not null default true;

alter table public.endpoint_daily_stats
  add column if not exists emails integer not null default 0;

-- Kept with the period_start it counts for, so whatever resets a period (a
-- lazy Free start, a Pro renewal, a plan change) starts the count over
-- without each reset path having to know about it.
alter table public.users
  add column if not exists emails_used integer not null default 0,
  add column if not exists emails_period_start timestamptz;

begin;

drop function if exists public.bump_endpoint_daily_stats(
  uuid, uuid, uuid, date, integer, integer, integer, bigint
);

create or replace function public.bump_endpoint_daily_stats(
  p_endpoint_id    uuid,
  p_user_id        uuid,
  p_team_id        uuid,
  p_day            date,
  p_captured       integer,
  p_team_billed    integer,
  p_quota_rejected integer,
  p_bytes          bigint,
  p_emails         integer default 0
)
returns void
language sql
set search_path = ''
as $$
  insert into public.endpoint_daily_stats as s (
    endpoint_id, day, user_id, team_id, captured, team_billed, quota_rejected, bytes, emails
  ) values (
    p_endpoint_id, p_day, p_user_id, p_team_id, p_captured, p_team_billed, p_quota_rejected,
    p_bytes, p_emails
  )
  on conflict (endpoint_id, day) do update
     set captured       = s.captured + excluded.captured,
         team_billed    = s.team_billed + excluded.team_billed,
         quota_rejected = s.quota_rejected + excluded.quota_rejected,
         bytes          = s.bytes + excluded.bytes,
         emails         = s.emails + excluded.emails,
         user_id        = coalesce(excluded.user_id, s.user_id),
         team_id        = coalesce(excluded.team_id, s.team_id);
$$;

revoke all on function public.bump_endpoint_daily_stats(
  uuid, uuid, uuid, date, integer, integer, integer, bigint, integer
) from public, anon, authenticated;
grant execute on function public.bump_endpoint_daily_stats(
  uuid, uuid, uuid, date, integer, integer, integer, bigint, integer
) to service_role;

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

commit;

-- 4. search_requests() also returns kind, email and body_raw, so search
--    results and older pages show emails as emails, and a message that is
--    not valid UTF-8 keeps its exact bytes for the raw view and the .eml
--    download. It and search_requests_count() take p_kind ('http' or
--    'email'), so the dashboard's kind switch pages through the database
--    rather than filtering what it has loaded. A changed signature needs
--    drop and create; the bodies are 00044's with the columns and the kind
--    filter added.
begin;

drop function if exists public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text);

CREATE OR REPLACE FUNCTION public.search_requests(p_user_id uuid, p_plan text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_method text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_from_ms bigint DEFAULT NULL::bigint, p_to_ms bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_order text DEFAULT 'desc'::text, p_kind text DEFAULT NULL::text)
 RETURNS TABLE(id text, slug text, method text, path text, headers jsonb, body text, query_params jsonb, content_type text, ip text, size integer, received_at bigint, kind text, email jsonb, body_raw bytea)
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
              r.content_type, r.ip, r.size, r.received_at, r.kind, r.email, r.body_raw
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       where r.user_id = $1
         and ($10 is null or r.endpoint_id = $10)
         and ($2 is null or e.slug = $2)
         and ($3 is null or $3 = ''ALL'' or r.method = $3)
         and ($11 is null or r.kind = $11)
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
              r.content_type, r.ip, r.size, r.received_at, r.kind, r.email, r.body_raw
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       left join public.users u on u.id = e.user_id
       where r.endpoint_id = any($8)
         and ($10 is null or r.endpoint_id = $10)
         and r.user_id is distinct from $1
         and ($2 is null or e.slug = $2)
         and ($3 is null or $3 = ''ALL'' or r.method = $3)
         and ($11 is null or r.kind = $11)
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
            floor(extract(epoch from x.received_at) * 1000)::bigint,
            x.kind, x.email, x.body_raw
     from (select * from owned union all select * from shared) x
     order by x.received_at %1$s
     limit %3$s offset %4$s',
    v_order,
    v_limit + v_offset,
    v_limit,
    v_offset
  )
  using p_user_id, nullif(btrim(p_slug), ''), nullif(btrim(p_method), ''), v_q, v_from, v_to,
        v_retention_cutoff, v_shared_ids, v_free_cutoff, v_endpoint_id, nullif(btrim(p_kind), '');
end;
$$;

revoke all on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text, text) to service_role;

drop function if exists public.search_requests_count(uuid, text, text, text, text, bigint, bigint);

CREATE OR REPLACE FUNCTION public.search_requests_count(p_user_id uuid, p_plan text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_method text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_from_ms bigint DEFAULT NULL::bigint, p_to_ms bigint DEFAULT NULL::bigint, p_kind text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_plan text := coalesce(p_plan, 'pro');
  v_slug text := nullif(btrim(p_slug), '');
  v_method text := nullif(btrim(p_method), '');
  v_kind text := nullif(btrim(p_kind), '');
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
      and (v_kind is null or r.kind = v_kind)
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
    and (v_kind is null or r.kind = v_kind)
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
    and (v_kind is null or r.kind = v_kind)
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

revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) to service_role;

commit;

-- 6. Backfills for email captured since 00048, before step 3's
--    capture_webhook() counted it. Email rows only exist since 00048 went
--    live on 2026-10-07, which bounds the scans to requests_received_at. The
--    rows being set are locked first, so a capture running now either
--    committed before the count (and is in it) or updates the row after this
--    commits (and is not counted twice).
do $$
begin
  -- endpoint_daily_stats.emails; greatest() keeps bumps for email the user
  -- has since deleted.
  perform 1
    from public.endpoint_daily_stats s
   where (s.endpoint_id, s.day) in (
           select r.endpoint_id, (r.received_at at time zone 'UTC')::date
             from public.requests r
            where r.kind = 'email'
              and r.received_at >= '2026-10-07')
     for update of s;

  update public.endpoint_daily_stats s
     set emails = greatest(s.emails, c.n)
    from (
      select r.endpoint_id, (r.received_at at time zone 'UTC')::date as day, count(*)::integer as n
        from public.requests r
       where r.kind = 'email'
         and r.received_at >= '2026-10-07'
       group by 1, 2
    ) c
   where s.endpoint_id = c.endpoint_id
     and s.day = c.day
     and s.emails < c.n;

  -- users.emails_used for the current period: the user's own (not
  -- team-billed) email rows since period_start. A lazy Free period starts at
  -- its first capture, whose MX receive time may be up to an hour earlier
  -- (the receiver's clamp_received_at), so Free periods count from an hour
  -- before period_start; this one-off count is capped by requests_used where
  -- it is read. A capture by the new
  -- capture_webhook() may already have started the counter for this period;
  -- its row is in the count, so greatest() reconciles without counting it
  -- twice, and keeps the counter if the user has since deleted email.
  perform 1
    from public.users u
   where u.period_start is not null
     and exists (
           select 1 from public.requests r
            where r.user_id = u.id
              and r.kind = 'email'
              and r.team_id is null
              and r.received_at >= greatest(
                    u.period_start - case when u.plan = 'free' then interval '1 hour' else interval '0' end,
                    '2026-10-07'))
     for update of u;

  update public.users u
     set emails_used = greatest(
           case when u.emails_period_start = u.period_start then u.emails_used else 0 end,
           c.n),
         emails_period_start = u.period_start
    from (
      select r.user_id, count(*)::integer as n
        from public.requests r
        join public.users ru on ru.id = r.user_id
       where r.kind = 'email'
         and r.team_id is null
         and r.received_at >= greatest(
               ru.period_start - case when ru.plan = 'free' then interval '1 hour' else interval '0' end,
               '2026-10-07')
       group by r.user_id
    ) c
   where u.id = c.user_id
     and u.period_start is not null;
end
$$;

notify pgrst, 'reload schema';
