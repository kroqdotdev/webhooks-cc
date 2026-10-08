-- 00050: forward captured email to a URL as signed JSON (email capture, phase 5).
--
-- 1. endpoints.forward_enabled, forward_url and forward_secret_encrypted
--    (AES-256-GCM with SIGNING_SECRET_KEY, like signing secrets): owner-only
--    settings, written through the endpoint PATCH route.
-- 2. email_deliveries: one row per email to forward, queued by
--    capture_webhook() in the capture's transaction. The web app's worker
--    claims due rows with claim_email_deliveries() (a lease, so a worker that
--    dies mid-send only delays the retry), sends them and reports each try to
--    record_email_delivery_attempt(), which schedules the next one. Rows go
--    with their request and their endpoint.
-- 3. email_delivery_attempts: the outcome of every try, for the dashboard.
-- 4. capture_webhook() queues the delivery; otherwise unchanged from 00049.
--
-- Service role only, like every other table here: the dashboard reads
-- deliveries through server routes.
--
-- Apply in autocommit mode (see AGENTS.md).

-- 1. Settings
alter table public.endpoints
  add column if not exists forward_enabled boolean not null default false,
  add column if not exists forward_url text,
  add column if not exists forward_secret_encrypted bytea;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'endpoints_forward_complete'
  ) then
    alter table public.endpoints
      add constraint endpoints_forward_complete check (
        not forward_enabled
        or (forward_url is not null and forward_secret_encrypted is not null)
      ) not valid;
  end if;
end
$$;
alter table public.endpoints validate constraint endpoints_forward_complete;

-- 2. The queue
create table if not exists public.email_deliveries (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.requests(id) on delete cascade,
  endpoint_id     uuid not null references public.endpoints(id) on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending', 'succeeded', 'failed')),
  -- Tries started so far; claim_email_deliveries() counts them.
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  -- Set while a worker holds the row; a claim past it may take the row over.
  locked_until    timestamptz,
  last_status     integer,
  last_error      text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists email_deliveries_due
  on public.email_deliveries (next_attempt_at) where status = 'pending';
-- Also serves the cascade when retention deletes requests.
create index if not exists email_deliveries_request
  on public.email_deliveries (request_id, created_at desc);
create index if not exists email_deliveries_endpoint
  on public.email_deliveries (endpoint_id, created_at desc);

alter table public.email_deliveries enable row level security;
revoke all on table public.email_deliveries from public, anon, authenticated;
-- The routes queue redeliveries and settle pending rows when forwarding is
-- turned off; claiming and recording go through the functions below.
grant select, insert, update, delete on table public.email_deliveries to service_role;

-- 3. Attempts
create table if not exists public.email_delivery_attempts (
  id               bigint generated always as identity primary key,
  delivery_id      uuid not null references public.email_deliveries(id) on delete cascade,
  attempted_at     timestamptz not null default now(),
  -- The response status, null when no response arrived.
  status           integer,
  duration_ms      integer not null check (duration_ms >= 0),
  error            text,
  response_excerpt text
);

create index if not exists email_delivery_attempts_delivery
  on public.email_delivery_attempts (delivery_id, attempted_at desc);

alter table public.email_delivery_attempts enable row level security;
revoke all on table public.email_delivery_attempts from public, anon, authenticated;
grant select, delete on table public.email_delivery_attempts to service_role;

-- Claims up to p_limit due deliveries, at most p_per_endpoint in flight per
-- endpoint, and leases them for p_lease_seconds. The locking step re-checks
-- status and lease on the latest row version, so two workers never claim the
-- same delivery. Endpoints with forwarding off are skipped (the PATCH route
-- settles their pending rows).
create or replace function public.claim_email_deliveries(
  p_limit         integer default 16,
  p_per_endpoint  integer default 2,
  p_lease_seconds integer default 60
)
returns table (
  delivery_id              uuid,
  request_id               uuid,
  endpoint_id              uuid,
  attempt                  integer,
  forward_url              text,
  forward_secret_encrypted text,
  show_email_extracts      boolean,
  endpoint_slug            text,
  endpoint_name            text
)
language sql
security definer set search_path = ''
as $$
  with in_flight as (
    select d.endpoint_id, count(*)::integer as n
      from public.email_deliveries d
     where d.status = 'pending'
       and d.locked_until > now()
     group by d.endpoint_id
  ),
  ranked as (
    select d.id, d.endpoint_id, d.next_attempt_at,
           row_number() over (
             partition by d.endpoint_id order by d.next_attempt_at, d.created_at
           ) as rn
      from public.email_deliveries d
      join public.endpoints e on e.id = d.endpoint_id
     where d.status = 'pending'
       and d.next_attempt_at <= now()
       and (d.locked_until is null or d.locked_until <= now())
       and e.forward_enabled
  ),
  candidates as (
    select r.id
      from ranked r
      left join in_flight f on f.endpoint_id = r.endpoint_id
     where r.rn + coalesce(f.n, 0) <= greatest(p_per_endpoint, 1)
     order by r.next_attempt_at
     limit greatest(least(p_limit, 100), 1)
  ),
  locked as (
    select d.id
      from public.email_deliveries d
     where d.id in (select c.id from candidates c)
       and d.status = 'pending'
       and (d.locked_until is null or d.locked_until <= now())
       for update skip locked
  )
  update public.email_deliveries d
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
         attempts = d.attempts + 1
    from public.endpoints e
   where d.id in (select l.id from locked l)
     and e.id = d.endpoint_id
  returning d.id, d.request_id, d.endpoint_id, d.attempts, e.forward_url,
            encode(e.forward_secret_encrypted, 'base64'), e.show_email_extracts,
            e.slug, e.name;
$$;

revoke all on function public.claim_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, integer, integer)
  to service_role;

-- Records one try and settles the delivery: succeeded, pending again in
-- p_retry_in_seconds, or failed when that is null. A delivery deleted in the
-- meantime (its request went to retention) is ignored.
create or replace function public.record_email_delivery_attempt(
  p_delivery_id       uuid,
  p_succeeded         boolean,
  p_status            integer,
  p_duration_ms       integer,
  p_error             text,
  p_response_excerpt  text,
  p_retry_in_seconds  integer
)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  perform 1 from public.email_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;

  insert into public.email_delivery_attempts (
    delivery_id, status, duration_ms, error, response_excerpt
  ) values (
    p_delivery_id, p_status, greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error, 500), left(p_response_excerpt, 1024)
  );

  update public.email_deliveries
     set status = case
           when p_succeeded then 'succeeded'
           when p_retry_in_seconds is null then 'failed'
           else 'pending'
         end,
         next_attempt_at = case
           when not p_succeeded and p_retry_in_seconds is not null
             then now() + make_interval(secs => greatest(p_retry_in_seconds, 1))
           else next_attempt_at
         end,
         locked_until = null,
         last_status = p_status,
         last_error = case when p_succeeded then null else left(p_error, 500) end,
         finished_at = case
           when p_succeeded or p_retry_in_seconds is null then now()
           else null
         end
   where id = p_delivery_id;
end;
$$;

revoke all on function public.record_email_delivery_attempt(
  uuid, boolean, integer, integer, text, text, integer
) from public, anon, authenticated;
grant execute on function public.record_email_delivery_attempt(
  uuid, boolean, integer, integer, text, text, integer
) to service_role;

-- 4. capture_webhook() queues the delivery. The body is 00049's with the
--    endpoint lookup reading forward_enabled and step 4b added.
begin;

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
         forward_enabled
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

  -- 4b. Forwarding: queue the delivery in the capture's own transaction, so
  -- a captured email is never lost before it is queued. The web app's worker
  -- sends it (claim_email_deliveries).
  if v_kind = 'email' and v_endpoint.forward_enabled then
    insert into public.email_deliveries (request_id, endpoint_id)
    values (v_request_id, v_endpoint.id);
  end if;

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

notify pgrst, 'reload schema';
