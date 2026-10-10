-- 00058: forwarding for HTTP requests too, not only email.
--
-- An endpoint's owner chooses what to forward (HTTP requests, emails or both)
-- to one URL. HTTP requests go out as received (the worker relays method,
-- headers and exact body), emails as signed JSON as before, and Slack or
-- Discord URLs get a chat message; the web app's worker decides the format
-- from forward_format and the URL. Every delivery lands in the same queue and
-- log, which keep their 00050 names: the tables and functions are internal,
-- and renaming them would need compatibility views across a deploy.
--
-- 1. endpoints: forward_http and forward_email (which kinds; email stays on
--    for rows that forwarded before), forward_format (null = pick from the
--    URL), forward_headers_encrypted (the owner's headers, AES-GCM like
--    signing secrets), forward_append_path, forward_retry_seconds (0, one
--    hour or one day) and forward_keep_order.
-- 2. requests.query_raw: the query string as sent, so a relay keeps the
--    order and repeats that query_params cannot.
-- 3. email_deliveries.kind, and a partial index for the pending cap.
-- 4. queue_capture_delivery(): queues one delivery if the request's kind is
--    switched on, or records it as not sent when too many are waiting for
--    the endpoint already (a dead URL must not grow the queue forever).
-- 5. claim_email_deliveries(): also hands out the format, headers, path and
--    retry settings; with forward_keep_order only an endpoint's oldest
--    pending delivery may go, and only when nothing of it is in flight.
-- 6. Turning a kind off settles that kind's pending deliveries.
-- 7. queue_email_redelivery(): redelivers either kind.
-- 8. capture_webhook(): p_query_raw, and step 5b for both kinds.
--
-- Service role only. Apply in autocommit mode (see AGENTS.md): the index is
-- built concurrently, outside any transaction block.

-- 1 to 3. Columns. Constant defaults are metadata-only on Postgres 11+, and
-- query_raw is nullable without a default; the checks are added NOT VALID and
-- validated after the transaction.
begin;

alter table public.endpoints
  add column if not exists forward_http boolean not null default false,
  add column if not exists forward_email boolean not null default true,
  add column if not exists forward_format text,
  add column if not exists forward_headers_encrypted bytea,
  add column if not exists forward_append_path boolean not null default true,
  add column if not exists forward_retry_seconds integer not null default 86400,
  add column if not exists forward_keep_order boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'endpoints_forward_format_check'
  ) then
    alter table public.endpoints
      add constraint endpoints_forward_format_check
      check (forward_format is null or forward_format in ('as_received', 'json', 'chat'))
      not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'endpoints_forward_retry_seconds_check'
  ) then
    alter table public.endpoints
      add constraint endpoints_forward_retry_seconds_check
      check (forward_retry_seconds in (0, 3600, 86400))
      not valid;
  end if;
end;
$$;

alter table public.requests add column if not exists query_raw text;

alter table public.email_deliveries
  add column if not exists kind text not null default 'email';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_deliveries_kind_check'
  ) then
    alter table public.email_deliveries
      add constraint email_deliveries_kind_check
      check (kind in ('email', 'http'))
      not valid;
  end if;
end;
$$;

commit;

alter table public.endpoints validate constraint endpoints_forward_format_check;
alter table public.endpoints validate constraint endpoints_forward_retry_seconds_check;
alter table public.email_deliveries validate constraint email_deliveries_kind_check;

create index concurrently if not exists email_deliveries_pending_endpoint
  on public.email_deliveries (endpoint_id) where status = 'pending';

begin;

-- 4. Queue one delivery for a captured request (or a redelivery). The caller
-- holds the endpoint row, so the switches read here cannot change under it.
create or replace function public.queue_capture_delivery(
  p_request_id  uuid,
  p_endpoint_id uuid,
  p_kind        text,
  p_max_pending integer default 1000
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_on      boolean;
  v_pending integer;
  v_id      uuid;
begin
  select e.forward_enabled and case p_kind
           when 'email' then e.forward_email
           when 'http' then e.forward_http
           else false
         end
    into v_on
    from public.endpoints e
   where e.id = p_endpoint_id;
  if not coalesce(v_on, false) then
    return null;
  end if;

  select count(*) into v_pending
    from (
      select 1
        from public.email_deliveries
       where endpoint_id = p_endpoint_id
         and status = 'pending'
       limit greatest(p_max_pending, 1)
    ) waiting;

  if v_pending >= greatest(p_max_pending, 1) then
    -- Recorded, so the log says why this request was not forwarded.
    insert into public.email_deliveries (
      request_id, endpoint_id, kind, status, last_error, finished_at
    ) values (
      p_request_id, p_endpoint_id, p_kind, 'failed',
      format('Not sent: %s deliveries were already waiting for this URL.', greatest(p_max_pending, 1)),
      now()
    )
    returning id into v_id;
    return v_id;
  end if;

  insert into public.email_deliveries (request_id, endpoint_id, kind)
  values (p_request_id, p_endpoint_id, p_kind)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.queue_capture_delivery(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.queue_capture_delivery(uuid, uuid, text, integer)
  to service_role;

-- 5. Claims up to p_limit due deliveries and leases them for p_lease_seconds.
-- Without keep-order, at most p_per_endpoint of an endpoint are in flight;
-- with it, only the endpoint's oldest pending delivery may go, and only when
-- none of the endpoint's deliveries is in flight, so they arrive in capture
-- order (a delivery waiting for its retry holds the later ones back). The
-- locking step re-checks status and lease on the latest row version, so two
-- workers never claim the same delivery. A kind that is switched off is
-- skipped (switching it off settles its pending rows, see section 6).
drop function if exists public.claim_email_deliveries(integer, integer, integer);
create function public.claim_email_deliveries(
  p_limit         integer default 16,
  p_per_endpoint  integer default 2,
  p_lease_seconds integer default 60
)
returns table (
  delivery_id               uuid,
  request_id                uuid,
  endpoint_id               uuid,
  attempt                   integer,
  kind                      text,
  queued_at                 timestamptz,
  forward_url               text,
  forward_secret_encrypted  text,
  forward_format            text,
  forward_headers_encrypted text,
  forward_append_path       boolean,
  forward_retry_seconds     integer,
  show_email_extracts       boolean,
  endpoint_slug             text,
  endpoint_name             text
)
language sql
security definer set search_path = ''
as $$
  -- Backstop: a delivery whose sends keep being interrupted before a result
  -- is recorded (each claim counts a try) fails instead of being claimed
  -- forever. The worker settles every recorded try well before this.
  update public.email_deliveries
     set status = 'failed',
         last_error = 'The delivery was interrupted too many times.',
         finished_at = now(),
         locked_until = null
   where status = 'pending'
     and attempts >= 12
     and (locked_until is null or locked_until <= now());

  with in_flight as (
    select d.endpoint_id, count(*)::integer as n
      from public.email_deliveries d
     where d.status = 'pending'
       and d.locked_until > now()
     group by d.endpoint_id
  ),
  pending as (
    select d.id, d.endpoint_id, d.created_at, d.next_attempt_at, d.locked_until,
           e.forward_keep_order as keep_order,
           row_number() over (
             partition by d.endpoint_id order by d.created_at, d.id
           ) as rn_order
      from public.email_deliveries d
      join public.endpoints e on e.id = d.endpoint_id
     where d.status = 'pending'
       and d.attempts < 12
       and e.forward_enabled
       and case d.kind when 'email' then e.forward_email else e.forward_http end
  ),
  due as (
    select p.id, p.endpoint_id, p.next_attempt_at, p.keep_order, p.rn_order,
           row_number() over (
             partition by p.endpoint_id order by p.next_attempt_at, p.created_at
           ) as rn
      from pending p
     where p.next_attempt_at <= now()
       and (p.locked_until is null or p.locked_until <= now())
  ),
  candidates as (
    select d.id
      from due d
      left join in_flight f on f.endpoint_id = d.endpoint_id
     where case
             when d.keep_order then d.rn_order = 1 and coalesce(f.n, 0) = 0
             else d.rn + coalesce(f.n, 0) <= greatest(p_per_endpoint, 1)
           end
     order by d.next_attempt_at
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
  returning d.id, d.request_id, d.endpoint_id, d.attempts, d.kind, d.created_at,
            e.forward_url, encode(e.forward_secret_encrypted, 'base64'), e.forward_format,
            encode(e.forward_headers_encrypted, 'base64'), e.forward_append_path,
            e.forward_retry_seconds, e.show_email_extracts, e.slug, e.name;
$$;

revoke all on function public.claim_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, integer, integer)
  to service_role;

-- 6. Turning forwarding, or one kind of it, off fails what of it is still
-- waiting, in the same transaction as the update: such rows would otherwise
-- go out whenever it is turned on again.
create or replace function public.settle_deliveries_when_forwarding_off()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.email_deliveries d
     set status = 'failed',
         last_error = case
           when not new.forward_enabled then 'Forwarding was turned off.'
           when d.kind = 'http' then 'Forwarding of HTTP requests was turned off.'
           else 'Forwarding of emails was turned off.'
         end,
         finished_at = now(),
         locked_until = null
   where d.endpoint_id = new.id
     and d.status = 'pending'
     and (not new.forward_enabled
          or (d.kind = 'http' and not new.forward_http)
          or (d.kind = 'email' and not new.forward_email));
  return null;
end;
$$;

revoke all on function public.settle_deliveries_when_forwarding_off()
  from public, anon, authenticated;

drop trigger if exists endpoints_forwarding_off on public.endpoints;
create trigger endpoints_forwarding_off
  after update of forward_enabled, forward_http, forward_email on public.endpoints
  for each row
  when ((old.forward_enabled and not new.forward_enabled)
        or (old.forward_http and not new.forward_http)
        or (old.forward_email and not new.forward_email))
  execute function public.settle_deliveries_when_forwarding_off();

-- 7. Queues another delivery of one captured request (either kind) for the
-- dashboard's Redeliver, under the endpoint row lock like capture_webhook()
-- step 5b: switching forwarding off either commits first and nothing is
-- queued, or waits for this and then settles the new row. Null when its kind
-- is not forwarded.
create or replace function public.queue_email_redelivery(
  p_request_id  uuid,
  p_endpoint_id uuid
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_kind text;
begin
  perform 1
    from public.endpoints
   where id = p_endpoint_id
     and forward_enabled
     for no key update;
  if not found then
    return null;
  end if;
  select r.kind into v_kind
    from public.requests r
   where r.id = p_request_id
     and r.endpoint_id = p_endpoint_id;
  if not found then
    return null;
  end if;
  return public.queue_capture_delivery(p_request_id, p_endpoint_id, v_kind);
end;
$$;

revoke all on function public.queue_email_redelivery(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_email_redelivery(uuid, uuid) to service_role;

-- 8. capture_webhook(): 00055's body, with p_query_raw stored as
-- requests.query_raw and step 5b queuing both kinds. The old signature goes
-- in the same transaction, so the receiver's calls never find two candidates.
drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer
);
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
  p_size        integer default null,
  -- The query string exactly as sent, for forwarding as received.
  p_query_raw   text default null
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
         forward_enabled, forward_http, forward_email, agent_registration_id
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
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key, query_raw
  ) values (
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key,
    nullif(left(p_query_raw, 8192), '')
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    perform public.increment_endpoint_request_count(v_endpoint.id, 1);
  end if;

  -- 5b. Forwarding: queue the delivery in the capture's own transaction, so
  -- a captured request is never lost before it is queued; the web app's
  -- worker sends it (claim_email_deliveries). Forwarding needs an owner, and
  -- step 5 holds an owned endpoint's row, so the switches are read again
  -- under that lock: turning a kind off either committed first and is seen
  -- here, or waits for this capture and then settles the queued row.
  if v_endpoint.forward_enabled
     and ((v_kind = 'email' and v_endpoint.forward_email)
          or (v_kind = 'http' and v_endpoint.forward_http)) then
    perform public.queue_capture_delivery(v_request_id, v_endpoint.id, v_kind);
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
  text, boolean, integer, text
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text
) to service_role;
commit;

notify pgrst, 'reload schema';
