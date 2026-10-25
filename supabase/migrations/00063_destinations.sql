-- 00063: destinations. An endpoint forwards to any number of destinations
-- (up to 10, enforced by the web app), each with its own URL, what it gets
-- (the kinds, and a filter the worker checks), how it goes out (as received,
-- signed JSON, a JSON template, or a chat message whose text can be a
-- template), its own signing secret and headers, retries and order, and two
-- options: at most one delivery every N seconds (a heads-up), and a delay
-- before the first try (a callback). Notifications become such a destination:
-- a chat message, at most one a second, not retried, now logged.
--
-- 1. endpoint_destinations, service role only. legacy_role marks the
--    destination the old endpoint fields stand for ('forward' for forward_*,
--    'notify' for notification_url), so API clients that set those keep
--    working; the web app maps them.
-- 2. email_deliveries.destination_id (set null when a destination goes, so
--    its log stays), status 'skipped' (the filter did not match, or a
--    heads-up came too late) and bypass_filter (a redelivery to one
--    destination asked for by hand).
-- 3. Backfill, on the first application only: one destination per endpoint
--    with a forwarding URL, one per notification URL (notification_url is
--    then cleared; the destination holds it). Pending deliveries move to
--    their endpoint's forward destination in the same transaction as the new
--    functions; the older log follows in batches at the end. The forward_*
--    columns stay until a later migration drops them.
-- 4. queue_destination_delivery(): one delivery for one destination, with
--    the throttle (checked and stamped here, under the destination's row
--    lock; for a destination with a filter the worker takes the slot once
--    the filter passed, take_destination_slot()), the delay, and the pending
--    cap per destination.
-- 5. capture_webhook(): step 5b queues one delivery per enabled destination
--    that takes the kind; notification_url is no longer returned (null), and
--    endpoint_name is (for {{ endpoint.name }} in mock responses).
-- 6. claim_email_deliveries(): same name, arguments and leading columns as
--    00058, read from the destination, so a web app still running the old
--    worker during the deploy sends each delivery to the right place; the
--    new columns follow. In-flight and keep-order are per destination.
-- 7. skip_email_delivery(): settles a claimed delivery the filter rejected.
-- 8. Redelivery per destination, the old functions over all destinations,
--    settling on switch-off and removal, summaries per destination.
--
-- Service role only. Apply in autocommit mode (see AGENTS.md): the indexes
-- are built concurrently and the log is relinked in committed batches, both
-- outside any transaction block. The first transaction is DDL only, so the
-- locks it takes on endpoints and email_deliveries are brief. If a step
-- fails (a lock timeout), run the file again: every step can repeat.

begin;

-- 1. Destinations
create table if not exists public.endpoint_destinations (
  id               uuid primary key default gen_random_uuid(),
  endpoint_id      uuid not null references public.endpoints(id) on delete cascade,
  position         integer not null default 0,
  name             text check (name is null or char_length(name) between 1 and 100),
  enabled          boolean not null default true,
  url              text not null check (char_length(url) between 1 and 2048),
  -- AES-GCM like signing secrets; null until a format that signs needs one.
  secret_encrypted bytea,
  http             boolean not null default true,
  email            boolean not null default true,
  -- null picks from the URL, as forward_format did.
  format           text check (format is null or format in ('as_received', 'json', 'chat', 'template')),
  -- {"logic": "and"|"or", "conditions": [...]}; null lets everything through.
  filter           jsonb check (filter is null or jsonb_typeof(filter) = 'object'),
  -- The body for format 'template': any JSON value with {{ placeholders }}.
  body_template    jsonb,
  -- The chat message's text for format 'chat'; null keeps the standard one.
  message_template text check (message_template is null or char_length(message_template) between 1 and 4000),
  headers_encrypted bytea,
  append_path      boolean not null default true,
  retry_seconds    integer not null default 86400 check (retry_seconds in (0, 3600, 86400)),
  keep_order       boolean not null default false,
  sent_field       text check (sent_field is null or char_length(sent_field) between 1 and 128),
  -- At most one delivery every throttle_seconds; the others are not sent.
  throttle_seconds integer not null default 0 check (throttle_seconds between 0 and 3600),
  -- The first try waits this long after the capture.
  delay_seconds    integer not null default 0 check (delay_seconds between 0 and 3600),
  last_queued_at   timestamptz,
  legacy_role      text check (legacy_role is null or legacy_role in ('forward', 'notify')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists endpoint_destinations_endpoint
  on public.endpoint_destinations (endpoint_id, position);
create unique index if not exists endpoint_destinations_legacy_role
  on public.endpoint_destinations (endpoint_id, legacy_role) where legacy_role is not null;

alter table public.endpoint_destinations enable row level security;
revoke all on table public.endpoint_destinations from public, anon, authenticated;
grant select, insert, update, delete on table public.endpoint_destinations to service_role;

-- 2. The queue. The foreign key is added not valid (no scan of the table
-- under its lock) and validated at the end.
alter table public.email_deliveries
  add column if not exists destination_id uuid,
  -- Sent whatever the destination's filter says: someone asked for it by hand.
  add column if not exists bypass_filter boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'email_deliveries_destination_id_fkey'
       and conrelid = 'public.email_deliveries'::regclass
  ) then
    alter table public.email_deliveries
      add constraint email_deliveries_destination_id_fkey
      foreign key (destination_id) references public.endpoint_destinations(id)
      on delete set null
      not valid;
  end if;
end;
$$;

alter table public.email_deliveries drop constraint if exists email_deliveries_status_check;
alter table public.email_deliveries
  add constraint email_deliveries_status_check
  check (status in ('pending', 'succeeded', 'failed', 'skipped'))
  not valid;

commit;

-- Indexes, before anything queues by destination. An earlier run that
-- failed part way can leave one invalid; it is dropped and built again.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.relname
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'public.email_deliveries'::regclass
       and not i.indisvalid
       and c.relname in ('email_deliveries_pending_destination', 'email_deliveries_destination')
  loop
    execute format('drop index public.%I', v_name);
  end loop;
end;
$$;

create index concurrently if not exists email_deliveries_pending_destination
  on public.email_deliveries (destination_id) where status = 'pending';
-- The log's destination filter, and the relink at the end.
create index concurrently if not exists email_deliveries_destination
  on public.email_deliveries (destination_id, created_at desc);

begin;

-- 3. Backfill, only when this file has not run before: the function created
-- below marks that it has. A second run must not bring back destinations
-- the owner removed since.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'queue_destination_delivery'
  ) then
    return;
  end if;

  insert into public.endpoint_destinations (
    endpoint_id, position, enabled, url, secret_encrypted, http, email, format,
    headers_encrypted, append_path, retry_seconds, keep_order, sent_field, legacy_role
  )
  select e.id, 0, e.forward_enabled, e.forward_url, e.forward_secret_encrypted,
         e.forward_http, e.forward_email, e.forward_format, e.forward_headers_encrypted,
         e.forward_append_path, e.forward_retry_seconds, e.forward_keep_order,
         e.forward_sent_field, 'forward'
    from public.endpoints e
   where e.forward_url is not null
     and e.forward_url <> ''
  on conflict do nothing;

  insert into public.endpoint_destinations (
    endpoint_id, position, name, enabled, url, http, email, format,
    retry_seconds, throttle_seconds, legacy_role
  )
  select e.id, 1, 'Notifications', true, e.notification_url, true, true, 'chat', 0, 1, 'notify'
    from public.endpoints e
   where e.notification_url is not null
     and e.notification_url <> ''
     and char_length(e.notification_url) <= 2048
  on conflict do nothing;

  update public.endpoints
     set notification_url = null
   where notification_url is not null;
end;
$$;

-- What is waiting goes to the forward destination with the new functions
-- (the claim below moves any the old capture_webhook queues before this
-- commits).
update public.email_deliveries d
   set destination_id = dest.id
  from public.endpoint_destinations dest
 where dest.endpoint_id = d.endpoint_id
   and dest.legacy_role = 'forward'
   and d.destination_id is null
   and d.status = 'pending';

-- 4. One delivery of a captured request to one destination. The destination
-- is read with a key share lock: a removal that is under way finishes first
-- and the row then reads as gone, instead of the insert below failing its
-- foreign key and taking the capture with it. The throttle stamp is an
-- update of that row, so two captures cannot both take the slot. A
-- destination with a filter is throttled by the worker once the filter
-- passed (take_destination_slot()), so a request it turns down does not use
-- up the slot. p_capture: the throttle and the delay apply to captures, not
-- to redeliveries.
drop function if exists public.queue_destination_delivery(uuid, uuid, uuid, text, integer, boolean);
create or replace function public.queue_destination_delivery(
  p_request_id     uuid,
  p_endpoint_id    uuid,
  p_destination_id uuid,
  p_kind           text,
  p_max_pending    integer default 1000,
  p_capture        boolean default true,
  p_bypass_filter  boolean default false
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dest    record;
  v_pending integer;
  v_id      uuid;
begin
  select d.enabled, d.http, d.email, d.throttle_seconds, d.delay_seconds,
         coalesce(jsonb_array_length(
           case when jsonb_typeof(d.filter -> 'conditions') = 'array' then d.filter -> 'conditions' end
         ), 0) > 0 as filtered
    into v_dest
    from public.endpoint_destinations d
   where d.id = p_destination_id
     and d.endpoint_id = p_endpoint_id
     for key share;
  if not found
     or not v_dest.enabled
     or not (case p_kind when 'email' then v_dest.email when 'http' then v_dest.http else false end)
  then
    return null;
  end if;

  -- At most one delivery every throttle_seconds; the rest are not queued.
  if p_capture and v_dest.throttle_seconds > 0 and not v_dest.filtered then
    update public.endpoint_destinations
       set last_queued_at = now()
     where id = p_destination_id
       and (last_queued_at is null
            or last_queued_at <= now() - make_interval(secs => v_dest.throttle_seconds));
    if not found then
      return null;
    end if;
  end if;

  select count(*) into v_pending
    from (
      select 1
        from public.email_deliveries
       where destination_id = p_destination_id
         and endpoint_id = p_endpoint_id
         and status = 'pending'
       limit greatest(p_max_pending, 1)
    ) waiting;

  if v_pending >= greatest(p_max_pending, 1) then
    -- Recorded, so the log says why this request was not forwarded.
    insert into public.email_deliveries (
      request_id, endpoint_id, destination_id, kind, status, last_error, finished_at
    ) values (
      p_request_id, p_endpoint_id, p_destination_id, p_kind, 'failed',
      format('Not sent: %s deliveries were already waiting for this URL.', greatest(p_max_pending, 1)),
      now()
    )
    returning id into v_id;
    return v_id;
  end if;

  insert into public.email_deliveries (
    request_id, endpoint_id, destination_id, kind, next_attempt_at, bypass_filter
  )
  values (
    p_request_id, p_endpoint_id, p_destination_id, p_kind,
    now() + case when p_capture then make_interval(secs => v_dest.delay_seconds) else interval '0' end,
    coalesce(p_bypass_filter, false)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.queue_destination_delivery(uuid, uuid, uuid, text, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.queue_destination_delivery(uuid, uuid, uuid, text, integer, boolean, boolean)
  to service_role;

-- 4b. The throttle of a destination with a filter, taken by the worker once
-- the filter let a delivery through: true when a delivery may go now (and
-- the slot is taken), false within throttle_seconds of the last one.
create or replace function public.take_destination_slot(p_destination_id uuid)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.endpoint_destinations
     set last_queued_at = now()
   where id = p_destination_id
     and (throttle_seconds = 0
          or last_queued_at is null
          or last_queued_at <= now() - make_interval(secs => throttle_seconds));
  return found;
end;
$$;

revoke all on function public.take_destination_slot(uuid) from public, anon, authenticated;
grant execute on function public.take_destination_slot(uuid) to service_role;

-- 5. capture_webhook(): 00058's body; step 5b queues per destination, and
-- the result carries endpoint_name instead of a notification URL.
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
  v_destination     record;
begin
  v_slug := p_slug;
  v_kind := coalesce(p_kind, 'http');
  if v_kind not in ('http', 'email') then
    raise exception 'invalid capture kind: %', v_kind using errcode = '22023';
  end if;
  v_day := (coalesce(p_received_at, now()) at time zone 'UTC')::date;

  -- 1. Look up endpoint by slug (now includes signing fields)
  select id, user_id, name, is_ephemeral, expires_at, mock_response, response_rules,
         request_count,
         signing_provider, signing_secret_encrypted, signing_header,
         agent_registration_id
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

  -- 5b. Forwarding: queue one delivery per enabled destination that takes
  -- this kind, in the capture's own transaction, so a captured request is
  -- never lost before it is queued; the web app's worker sends them
  -- (claim_email_deliveries) and checks each destination's filter there.
  -- A destination switched off while this runs leaves at most a row the
  -- claim settles.
  for v_destination in
    select d.id
      from public.endpoint_destinations d
     where d.endpoint_id = v_endpoint.id
       and d.enabled
       and case v_kind when 'email' then d.email else d.http end
     order by d.position, d.created_at
  loop
    perform public.queue_destination_delivery(v_request_id, v_endpoint.id, v_destination.id, v_kind);
  end loop;

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
    -- Notifications are destinations now (00063); the receiver sends none.
    'notification_url', null::text,
    'endpoint_name', v_endpoint.name,
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

-- 6. Claims up to p_limit due deliveries and leases them for p_lease_seconds.
-- Without keep-order, at most p_per_endpoint of a destination are in flight
-- (the name stays from 00058); with it, only the destination's oldest
-- pending delivery may go, and only when none of its deliveries is in
-- flight. The leading columns are 00058's, read from the destination, so a
-- web app still running the old worker sends each delivery where it
-- belongs. That worker cannot send without a secret or fill in a template,
-- so without p_all only deliveries it can send are claimed; the rest wait
-- for the new worker, which passes p_all.
drop function if exists public.claim_email_deliveries(integer, integer, integer);
drop function if exists public.claim_email_deliveries(integer, integer, integer, boolean);
create function public.claim_email_deliveries(
  p_limit         integer default 16,
  p_per_endpoint  integer default 2,
  p_lease_seconds integer default 60,
  p_all           boolean default false
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
  forward_sent_field        text,
  show_email_extracts       boolean,
  endpoint_slug             text,
  endpoint_name             text,
  destination_id            uuid,
  destination_name          text,
  destination_filter        jsonb,
  body_template             jsonb,
  message_template          text,
  signing_provider          text,
  bypass_filter             boolean,
  throttle_seconds          integer
)
language sql
security definer set search_path = ''
as $$
  -- A delivery the old capture_webhook() queued while this migration ran
  -- has no destination: it belongs to the endpoint's forward destination.
  -- (Removing a destination settles what of it is waiting first, so no other
  -- pending delivery lacks one.) Goes with the forward_* columns.
  update public.email_deliveries d
     set destination_id = dest.id
    from public.endpoint_destinations dest
   where d.destination_id is null
     and d.status = 'pending'
     and dest.endpoint_id = d.endpoint_id
     and dest.legacy_role = 'forward';

  -- Backstops: a delivery whose sends keep being interrupted before a result
  -- is recorded fails instead of being claimed forever; one whose
  -- destination went, was switched off or no longer takes its kind (a
  -- capture that raced the change) is settled.
  update public.email_deliveries
     set status = 'failed',
         last_error = 'The delivery was interrupted too many times.',
         finished_at = now(),
         locked_until = null
   where status = 'pending'
     and attempts >= 12
     and (locked_until is null or locked_until <= now());

  update public.email_deliveries d
     set status = 'failed',
         last_error = case
           when dest.id is null then 'The destination was removed.'
           when not dest.enabled then 'The destination was switched off.'
           when d.kind = 'http' then 'The destination no longer takes HTTP requests.'
           else 'The destination no longer takes emails.'
         end,
         finished_at = now(),
         locked_until = null
    from public.email_deliveries pending
    left join public.endpoint_destinations dest on dest.id = pending.destination_id
   where d.id = pending.id
     and pending.status = 'pending'
     and (pending.locked_until is null or pending.locked_until <= now())
     and pending.next_attempt_at <= now()
     and (dest.id is null
          or not dest.enabled
          or not case pending.kind when 'email' then dest.email else dest.http end);

  with in_flight as (
    select d.destination_id, count(*)::integer as n
      from public.email_deliveries d
     where d.status = 'pending'
       and d.locked_until > now()
     group by d.destination_id
  ),
  pending as (
    select d.id, d.destination_id, d.created_at, d.next_attempt_at, d.locked_until,
           dest.keep_order,
           row_number() over (
             partition by d.destination_id order by d.created_at, d.id
           ) as rn_order
      from public.email_deliveries d
      join public.endpoint_destinations dest on dest.id = d.destination_id
     where d.status = 'pending'
       and d.attempts < 12
       and dest.enabled
       and case d.kind when 'email' then dest.email else dest.http end
       and (p_all
            or (dest.secret_encrypted is not null
                and coalesce(dest.format, '') <> 'template'
                and dest.filter is null
                and dest.message_template is null))
  ),
  due as (
    select p.id, p.destination_id, p.next_attempt_at, p.keep_order, p.rn_order,
           row_number() over (
             partition by p.destination_id order by p.next_attempt_at, p.created_at
           ) as rn
      from pending p
     where p.next_attempt_at <= now()
       and (p.locked_until is null or p.locked_until <= now())
  ),
  candidates as (
    select d.id
      from due d
      left join in_flight f on f.destination_id = d.destination_id
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
    from public.endpoint_destinations dest, public.endpoints e
   where d.id in (select l.id from locked l)
     and dest.id = d.destination_id
     and e.id = d.endpoint_id
  returning d.id, d.request_id, d.endpoint_id, d.attempts, d.kind,
            -- The retry window counts from the first try, after any delay.
            d.created_at + make_interval(secs => dest.delay_seconds),
            dest.url, encode(dest.secret_encrypted, 'base64'), dest.format,
            encode(dest.headers_encrypted, 'base64'), dest.append_path,
            dest.retry_seconds, dest.sent_field, e.show_email_extracts, e.slug, e.name,
            dest.id, dest.name, dest.filter, dest.body_template, dest.message_template,
            e.signing_provider, d.bypass_filter, dest.throttle_seconds;
$$;

revoke all on function public.claim_email_deliveries(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, integer, integer, boolean)
  to service_role;

-- 7. Settles a claimed delivery the destination's filter turned down: no
-- try was made, so the claim's count is taken back. Only the current claim may.
create or replace function public.skip_email_delivery(
  p_delivery_id uuid,
  p_attempt     integer,
  p_reason      text
)
returns void
language sql
security definer set search_path = ''
as $$
  update public.email_deliveries
     set status = 'skipped',
         attempts = greatest(attempts - 1, 0),
         locked_until = null,
         finished_at = now(),
         last_error = left(p_reason, 500)
   where id = p_delivery_id
     and status = 'pending'
     and attempts = p_attempt;
$$;

revoke all on function public.skip_email_delivery(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.skip_email_delivery(uuid, integer, text) to service_role;

-- 8a. Redelivers one request to one destination now (no throttle, no delay,
-- and whatever its filter says: someone asked for it by hand). Null when the
-- destination is off, does not take the kind, or the request is not the
-- endpoint's.
create or replace function public.queue_destination_redelivery(
  p_request_id     uuid,
  p_destination_id uuid
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_endpoint_id uuid;
  v_kind        text;
begin
  select d.endpoint_id into v_endpoint_id
    from public.endpoint_destinations d
   where d.id = p_destination_id;
  if not found then
    return null;
  end if;
  select r.kind into v_kind
    from public.requests r
   where r.id = p_request_id
     and r.endpoint_id = v_endpoint_id;
  if not found then
    return null;
  end if;
  return public.queue_destination_delivery(
    p_request_id, v_endpoint_id, p_destination_id, v_kind, 1000, false, true
  );
end;
$$;

revoke all on function public.queue_destination_redelivery(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_destination_redelivery(uuid, uuid) to service_role;

-- 8b. 00058's Redeliver for a request, over every destination that takes its
-- kind. Returns the first delivery queued, or null.
create or replace function public.queue_email_redelivery(
  p_request_id  uuid,
  p_endpoint_id uuid
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_kind  text;
  v_dest  record;
  v_id    uuid;
  v_first uuid;
begin
  select r.kind into v_kind
    from public.requests r
   where r.id = p_request_id
     and r.endpoint_id = p_endpoint_id;
  if not found then
    return null;
  end if;
  for v_dest in
    select d.id
      from public.endpoint_destinations d
     where d.endpoint_id = p_endpoint_id
       and d.enabled
       and case v_kind when 'email' then d.email else d.http end
     order by d.position, d.created_at
  loop
    v_id := public.queue_destination_delivery(
      p_request_id, p_endpoint_id, v_dest.id, v_kind, 1000, false
    );
    v_first := coalesce(v_first, v_id);
  end loop;
  return v_first;
end;
$$;

revoke all on function public.queue_email_redelivery(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_email_redelivery(uuid, uuid) to service_role;

-- 8c. Queues every request whose latest delivery to a destination failed
-- again, oldest capture first, for the log's "Redeliver all failed": every
-- destination of the endpoint, or only p_destination_id. A destination that
-- is off or no longer takes the kind is left out, and none gets more than
-- the room left under its pending cap. Rows queued together get created_at
-- a microsecond apart in capture order, so keep-order sends them in order.
drop function if exists public.queue_failed_redeliveries(uuid, integer);
create or replace function public.queue_failed_redeliveries(
  p_endpoint_id    uuid,
  p_max_pending    integer default 1000,
  p_destination_id uuid default null
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_cap   integer := greatest(p_max_pending, 1);
  v_room  jsonb := '{}'::jsonb;
  v_left  integer;
  v_row   record;
  v_ord   integer := 0;
  v_count integer := 0;
begin
  -- Room left under each destination's cap.
  for v_row in
    select d.id,
           v_cap - (
             select count(*) from (
               select 1 from public.email_deliveries q
                where q.destination_id = d.id and q.status = 'pending'
                limit v_cap
             ) waiting
           ) as room
      from public.endpoint_destinations d
     where d.endpoint_id = p_endpoint_id
       and d.enabled
       and (p_destination_id is null or d.id = p_destination_id)
  loop
    v_room := v_room || jsonb_build_object(v_row.id::text, v_row.room);
  end loop;
  if v_room = '{}'::jsonb then
    return 0;
  end if;

  -- Candidates oldest first along email_deliveries_failed_endpoint, so an
  -- endpoint with a long failed history reads only what it can queue; then
  -- in capture order.
  for v_row in
    select c.request_id, c.kind, c.destination_id
      from (
        select f.request_id, f.kind, f.destination_id
          from public.email_deliveries f
          join public.endpoint_destinations d on d.id = f.destination_id
         where f.endpoint_id = p_endpoint_id
           and f.status = 'failed'
           and (p_destination_id is null or f.destination_id = p_destination_id)
           and d.enabled
           and case f.kind when 'email' then d.email else d.http end
           and not exists (
             select 1
               from public.email_deliveries later
              where later.request_id = f.request_id
                and later.destination_id = f.destination_id
                and (later.created_at, later.id) > (f.created_at, f.id)
           )
         order by f.created_at
         limit v_cap * 10
      ) c
      join public.requests r on r.id = c.request_id
     order by r.received_at, r.id
  loop
    v_left := coalesce((v_room ->> v_row.destination_id::text)::integer, 0);
    continue when v_left <= 0;
    v_ord := v_ord + 1;
    insert into public.email_deliveries (request_id, endpoint_id, destination_id, kind, created_at)
    values (
      v_row.request_id, p_endpoint_id, v_row.destination_id, v_row.kind,
      now() + make_interval(secs => v_ord / 1000000.0)
    );
    v_room := jsonb_set(v_room, array[v_row.destination_id::text], to_jsonb(v_left - 1));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.queue_failed_redeliveries(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_failed_redeliveries(uuid, integer, uuid) to service_role;

-- 8d. Switching a destination off, or one kind of it, fails what of it is
-- still waiting; removing it does too (before its rows lose the link).
create or replace function public.settle_destination_deliveries()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.email_deliveries
       set status = 'failed',
           last_error = 'The destination was removed.',
           finished_at = now(),
           locked_until = null
     where destination_id = old.id
       and status = 'pending';
    return old;
  end if;
  update public.email_deliveries d
     set status = 'failed',
         last_error = case
           when not new.enabled then 'The destination was switched off.'
           when d.kind = 'http' then 'The destination no longer takes HTTP requests.'
           else 'The destination no longer takes emails.'
         end,
         finished_at = now(),
         locked_until = null
   where d.destination_id = new.id
     and d.status = 'pending'
     and (not new.enabled
          or (d.kind = 'http' and not new.http)
          or (d.kind = 'email' and not new.email));
  return null;
end;
$$;

revoke all on function public.settle_destination_deliveries() from public, anon, authenticated;

drop trigger if exists endpoint_destinations_off on public.endpoint_destinations;
create trigger endpoint_destinations_off
  after update of enabled, http, email on public.endpoint_destinations
  for each row
  when ((old.enabled and not new.enabled)
        or (old.http and not new.http)
        or (old.email and not new.email))
  execute function public.settle_destination_deliveries();

drop trigger if exists endpoint_destinations_removed on public.endpoint_destinations;
create trigger endpoint_destinations_removed
  before delete on public.endpoint_destinations
  for each row
  execute function public.settle_destination_deliveries();

-- 8d'. Before a destination is removed, its finished log lets go of it a
-- batch at a time, so the delete itself (which sets the rest to null under
-- the row's lock, while captures of the endpoint wait to read it) stays
-- short however long the log is. Returns how many rows let go.
create or replace function public.detach_destination_log(
  p_destination_id uuid,
  p_limit          integer default 5000
)
returns integer
language sql
security definer set search_path = ''
as $$
  with batch as (
    select d.id
      from public.email_deliveries d
     where d.destination_id = p_destination_id
       and d.status <> 'pending'
     limit greatest(least(p_limit, 10000), 1)
  ), detached as (
    update public.email_deliveries d
       set destination_id = null
     where d.id in (select b.id from batch b)
    returning 1
  )
  select count(*)::integer from detached;
$$;

revoke all on function public.detach_destination_log(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.detach_destination_log(uuid, integer) to service_role;

-- The endpoint's forward_* switches no longer decide anything, and nothing
-- queues per endpoint any more. queue_capture_delivery() stays until the
-- forward_* columns go: a capture still running the old capture_webhook()
-- when this commits calls it, and the claim moves what it queues.
drop trigger if exists endpoints_forwarding_off on public.endpoints;

-- 8e. Per destination: delivered, failed and skipped among deliveries queued
-- since p_since (the newest 100,000), and what is waiting now.
create or replace function public.destination_summaries(
  p_endpoint_id uuid,
  p_since       timestamptz
)
returns table (
  destination_id   uuid,
  delivered_recent integer,
  failed_recent    integer,
  skipped_recent   integer,
  pending          integer
)
language sql
stable
security definer set search_path = ''
as $$
  with recent as (
    select d.destination_id, d.status
      from public.email_deliveries d
     where d.endpoint_id = p_endpoint_id
       and d.created_at >= p_since
     order by d.created_at desc
     limit 100000
  ),
  counts as (
    select r.destination_id,
           count(*) filter (where r.status = 'succeeded')::integer as delivered_recent,
           count(*) filter (where r.status = 'failed')::integer as failed_recent,
           count(*) filter (where r.status = 'skipped')::integer as skipped_recent
      from recent r
     where r.destination_id is not null
     group by r.destination_id
  )
  select dest.id,
         coalesce(c.delivered_recent, 0),
         coalesce(c.failed_recent, 0),
         coalesce(c.skipped_recent, 0),
         (select count(*)::integer from (
            select 1 from public.email_deliveries q
             where q.destination_id = dest.id and q.status = 'pending'
             limit 100000) waiting)
    from public.endpoint_destinations dest
    left join counts c on c.destination_id = dest.id
   where dest.endpoint_id = p_endpoint_id;
$$;

revoke all on function public.destination_summaries(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.destination_summaries(uuid, timestamptz) to service_role;

commit;

notify pgrst, 'reload schema';

-- The older log joins its forward destination in batches, each committed,
-- so the per-destination log, its counts and "Redeliver all failed" read it
-- as that destination's. Only rows from before the destination existed:
-- later ones without one belong to a destination that was removed.
do $$
declare
  v_moved integer;
begin
  loop
    update public.email_deliveries d
       set destination_id = dest.id
      from public.endpoint_destinations dest
     where d.id in (
             select x.id
               from public.email_deliveries x
               join public.endpoint_destinations f
                 on f.endpoint_id = x.endpoint_id and f.legacy_role = 'forward'
              where x.destination_id is null
                and x.created_at < f.created_at
              limit 5000
           )
       and dest.endpoint_id = d.endpoint_id
       and dest.legacy_role = 'forward';
    get diagnostics v_moved = row_count;
    commit;
    exit when v_moved = 0;
  end loop;
end;
$$;

alter table public.email_deliveries validate constraint email_deliveries_status_check;
alter table public.email_deliveries validate constraint email_deliveries_destination_id_fkey;

notify pgrst, 'reload schema';
