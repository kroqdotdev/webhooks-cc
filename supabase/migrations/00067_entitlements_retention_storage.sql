-- 00067: foundations for email parsing and the Business plan. No visible change
-- for any account today; later migrations build on these pieces.
--
--   1. plan_entitlements: one row per plan (free, pro, business) and team
--      kind (team, team_business) with every limit and feature that differs
--      between them. SQL functions read it instead of comparing plan names,
--      and the web app mirrors it in lib/entitlements.ts (an integration
--      test compares the two). business is defined here but not sold yet.
--   2. users.plan may be 'business'. users.billing_interval and
--      users.billing_period_end hold the subscription's billing period;
--      period_start and period_end stay the quota period everything reads.
--      They are the same for monthly plans; an annual plan's quota period
--      rolls every month while the billing period runs on.
--   3. Retention per endpoint: endpoints.retention_days (shorter than the
--      plan's, never longer) and endpoints.delete_after_delivery ("deliver,
--      then delete"). A downgrade keeps the old retention for a grace period
--      (retention_floor_days until retention_floor_until on users and teams).
--      cleanup_expired_requests() replaces the two daily cleanups: it runs
--      hourly, per account and per endpoint through the existing indexes,
--      in bounded batches, so no run holds locks on a large share of the
--      table. cleanup_delivered_requests() runs every minute.
--   4. Object storage: the receiver stores an email's raw message and its
--      attachments in S3-compatible storage under m/{request_id}/ and passes
--      that prefix to capture_webhook() (new p_request_id and
--      p_object_prefix). A row trigger queues the prefix of every deleted
--      request that has one, whatever deleted it (retention, the API, an
--      endpoint or account cascade); the web app drains the queue
--      (claim_storage_deletions). The trigger's WHEN clause keeps HTTP rows
--      out of it.
--
-- capture_webhook() and check_email_recipient() change together, as always.
-- Every statement runs on its own (autocommit), so no statement holds a lock
-- on one table while waiting for another: captures lock endpoints, users and
-- requests in that order, and a migration holding them in another order
-- would deadlock with them. Only capture_webhook()'s drop and create share a
-- transaction, so there is never a moment without it. Every statement can be
-- run again. Apply in autocommit mode (see AGENTS.md).


-- 1. Entitlements
create table if not exists public.plan_entitlements (
  key                  text primary key
                       check (key in ('free', 'pro', 'business', 'team', 'team_business')),
  -- Requests per quota period. For team keys: per seat.
  request_limit        integer not null check (request_limit >= 0),
  -- Requests added to a team's pool on top of the seats (team_business).
  pool_requests        integer not null default 0 check (pool_requests >= 0),
  -- 'day': the lazy 24-hour period free accounts have; 'month': a paid period.
  quota_period         text not null check (quota_period in ('day', 'month')),
  retention_days       integer not null check (retention_days between 1 and 365),
  parsed_pages         integer not null check (parsed_pages >= 0),
  layouts_per_endpoint integer not null check (layouts_per_endpoint >= 0),
  ai_assists           integer not null check (ai_assists >= 0),
  custom_domains       integer not null check (custom_domains >= 0),
  file_drops           boolean not null,
  -- Request blocks and request overage (migration 00065).
  request_addons       boolean not null,
  -- Page blocks and page overage.
  page_addons          boolean not null,
  annual_billing       boolean not null
);

insert into public.plan_entitlements as pe (
  key, request_limit, pool_requests, quota_period, retention_days, parsed_pages,
  layouts_per_endpoint, ai_assists, custom_domains, file_drops, request_addons,
  page_addons, annual_billing
) values
  ('free',          50,     0,      'day',   7,  20,   2,  5,   0, false, false, false, false),
  ('pro',           100000, 0,      'month', 31, 100,  2,  20,  0, false, true,  false, false),
  ('business',      250000, 0,      'month', 90, 2000, 50, 500, 1, true,  true,  true,  true),
  ('team',          100000, 0,      'month', 31, 100,  2,  20,  0, false, true,  false, false),
  ('team_business', 100000, 150000, 'month', 90, 2000, 50, 500, 1, true,  true,  true,  false)
on conflict (key) do update set
  request_limit = excluded.request_limit,
  pool_requests = excluded.pool_requests,
  quota_period = excluded.quota_period,
  retention_days = excluded.retention_days,
  parsed_pages = excluded.parsed_pages,
  layouts_per_endpoint = excluded.layouts_per_endpoint,
  ai_assists = excluded.ai_assists,
  custom_domains = excluded.custom_domains,
  file_drops = excluded.file_drops,
  request_addons = excluded.request_addons,
  page_addons = excluded.page_addons,
  annual_billing = excluded.annual_billing;

alter table public.plan_entitlements enable row level security;
revoke all on table public.plan_entitlements from public, anon, authenticated;
grant select on table public.plan_entitlements to service_role;

-- 2. Plans and periods
alter table public.users drop constraint if exists users_plan_check;
alter table public.users
  add constraint users_plan_check check (plan in ('free', 'pro', 'business')) not valid;

alter table public.users
  add column if not exists billing_interval text,
  add column if not exists billing_period_end timestamptz,
  add column if not exists retention_floor_days integer,
  add column if not exists retention_floor_until timestamptz;

alter table public.users drop constraint if exists users_billing_interval_check;
alter table public.users
  add constraint users_billing_interval_check
  check (billing_interval is null or billing_interval in ('month', 'year')) not valid;

alter table public.users drop constraint if exists users_retention_floor_check;
alter table public.users
  add constraint users_retention_floor_check
  check (retention_floor_days is null or retention_floor_days between 1 and 365) not valid;

alter table public.teams
  add column if not exists business boolean not null default false,
  add column if not exists retention_floor_days integer,
  add column if not exists retention_floor_until timestamptz;

alter table public.teams drop constraint if exists teams_retention_floor_check;
alter table public.teams
  add constraint teams_retention_floor_check
  check (retention_floor_days is null or retention_floor_days between 1 and 365) not valid;

-- The entitlements of the account a capture bills: a team when p_team_id is
-- given, otherwise the user (free when the row is missing).
create or replace function public.account_entitlements(p_user_id uuid, p_team_id uuid)
returns public.plan_entitlements
language sql
stable
security definer set search_path = ''
as $$
  select pe.*
    from public.plan_entitlements pe
   where pe.key = case
     when p_team_id is not null then (
       select case when t.business then 'team_business' else 'team' end
         from public.teams t
        where t.id = p_team_id
     )
     else coalesce((select u.plan from public.users u where u.id = p_user_id), 'free')
   end
$$;

-- Days a request is kept for an account: its plan's, or the grace floor kept
-- after a downgrade, whichever is longer.
create or replace function public.account_retention_days(p_user_id uuid, p_team_id uuid)
returns integer
language sql
stable
security definer set search_path = ''
as $$
  select greatest(
    (public.account_entitlements(p_user_id, p_team_id)).retention_days,
    case
      when p_team_id is not null then (
        select case when t.retention_floor_until > now() then t.retention_floor_days end
          from public.teams t where t.id = p_team_id)
      else (
        select case when u.retention_floor_until > now() then u.retention_floor_days end
          from public.users u where u.id = p_user_id)
    end
  )
$$;

-- A downgrade keeps the old retention for 7 days, whichever path made it
-- (the renewal job, a Polar revoke, a hand edit), so a lapsed payment or a
-- plan change never deletes a week of requests the moment it lands.
create or replace function public.keep_retention_floor()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_old_key text;
  v_new_key text;
  v_old_days integer;
  v_new_days integer;
begin
  if tg_table_name = 'users' then
    v_old_key := old.plan;
    v_new_key := new.plan;
  else
    v_old_key := case when old.business then 'team_business' else 'team' end;
    v_new_key := case when new.business then 'team_business' else 'team' end;
  end if;
  select pe.retention_days into v_old_days from public.plan_entitlements pe where pe.key = v_old_key;
  select pe.retention_days into v_new_days from public.plan_entitlements pe where pe.key = v_new_key;
  if v_old_days is not null and v_new_days is not null and v_new_days < v_old_days then
    new.retention_floor_days := greatest(
      coalesce(case when old.retention_floor_until > now() then old.retention_floor_days end, 0),
      v_old_days
    );
    new.retention_floor_until := now() + interval '7 days';
  end if;
  return new;
end;
$$;

revoke execute on function public.keep_retention_floor() from public, anon, authenticated;

drop trigger if exists users_keep_retention_floor on public.users;
create trigger users_keep_retention_floor
  before update of plan on public.users
  for each row
  when (old.plan is distinct from new.plan)
  execute function public.keep_retention_floor();

drop trigger if exists teams_keep_retention_floor on public.teams;
create trigger teams_keep_retention_floor
  before update of business on public.teams
  for each row
  when (old.business is distinct from new.business)
  execute function public.keep_retention_floor();

-- 3. Retention per endpoint
alter table public.endpoints
  add column if not exists retention_days integer,
  add column if not exists delete_after_delivery boolean not null default false;

alter table public.endpoints drop constraint if exists endpoints_retention_days_check;
alter table public.endpoints
  add constraint endpoints_retention_days_check
  check (retention_days is null or retention_days between 1 and 365) not valid;

-- 4. Object storage
alter table public.requests
  add column if not exists object_prefix text;

alter table public.requests drop constraint if exists requests_object_prefix_check;
alter table public.requests
  add constraint requests_object_prefix_check
  check (object_prefix is null or object_prefix ~ '^m/[0-9a-f-]{36}/$') not valid;

create table if not exists public.storage_deletions (
  id           bigint generated always as identity primary key,
  prefix       text not null check (prefix ~ '^m/[0-9a-f-]{36}/$'),
  created_at   timestamptz not null default now(),
  attempts     integer not null default 0,
  locked_until timestamptz
);

create index if not exists storage_deletions_due
  on public.storage_deletions (coalesce(locked_until, '-infinity'::timestamptz), id);

alter table public.storage_deletions enable row level security;
revoke all on table public.storage_deletions from public, anon, authenticated;
grant select, insert, update, delete on table public.storage_deletions to service_role;

create or replace function public.queue_request_objects_deletion()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.storage_deletions (prefix) values (old.object_prefix);
  return null;
end;
$$;

drop trigger if exists requests_queue_objects_deletion on public.requests;
create trigger requests_queue_objects_deletion
  after delete on public.requests
  for each row
  when (old.object_prefix is not null)
  execute function public.queue_request_objects_deletion();

-- Prefixes to delete, leased so several web processes can drain the queue; a
-- crash only delays a deletion until the lease runs out.
create or replace function public.claim_storage_deletions(
  p_limit integer default 100,
  p_lease_seconds integer default 300
)
returns table(id bigint, prefix text, attempts integer)
language sql
security definer set search_path = ''
as $$
  update public.storage_deletions d
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         attempts = d.attempts + 1
   where d.id in (
     select s.id
       from public.storage_deletions s
      where coalesce(s.locked_until, '-infinity'::timestamptz) < now()
      order by coalesce(s.locked_until, '-infinity'::timestamptz), s.id
      limit least(greatest(p_limit, 1), 1000)
      for update skip locked
   )
  returning d.id, d.prefix, d.attempts;
$$;

create or replace function public.complete_storage_deletions(p_ids bigint[])
returns integer
language sql
security definer set search_path = ''
as $$
  with gone as (
    delete from public.storage_deletions where id = any(p_ids) returning 1
  )
  select count(*)::integer from gone;
$$;


-- 5. capture_webhook(): base is 00065. The receiver may choose the request's
-- id and pass the object-storage prefix it stored the message under; the
-- free plan's lazy daily period comes from the entitlements (quota_period
-- 'day') instead of the plan's name. A new signature needs drop and create.
begin;

drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text
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
  p_query_raw   text default null,
  -- The id to store the request under (the receiver names stored objects
  -- after it); generated when null.
  p_request_id  uuid default null,
  -- m/{p_request_id}/ when the message and its attachments are in object
  -- storage.
  p_object_prefix text default null
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
  -- How a capture past the allowance was paid for: 'credit' (a one-time
  -- block) or 'overage'; null when it was not.
  v_extra           text;
  v_included        boolean;
  v_team_active     boolean;
begin
  v_slug := p_slug;
  v_kind := coalesce(p_kind, 'http');
  if p_object_prefix is not null
     and (p_request_id is null or p_object_prefix <> 'm/' || p_request_id::text || '/') then
    raise exception 'object prefix must be m/<request id>/' using errcode = '22023';
  end if;
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
    select t.id, t.period_end, t.credit_requests, t.overage_active
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
         and requests_used < request_limit + block_requests;

      if found then
        v_billing_team_id := v_team.id;
      else
        -- No row updated: pool exhausted, or the team deactivated since the
        -- select. Only a still-active team may answer quota_exceeded; a
        -- deactivated one falls through to the owner's personal quota below.
        perform 1 from public.teams
         where id = v_team.id
           and subscription_status is not null;
        v_team_active := found;

        -- A still-active team past its pool spends a one-time block, then
        -- overage, before it answers quota_exceeded.
        if v_team_active and (v_team.credit_requests > 0 or v_team.overage_active) then
          v_extra := public.take_extra_request(null, v_team.id);
          if v_extra is not null then
            v_billing_team_id := v_team.id;
          end if;
        end if;

        if v_team_active and v_extra is null then
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
      select u.id, u.plan, u.request_limit, u.requests_used, u.period_end, u.credit_requests,
             u.overage_active, pe.quota_period
        into v_user
        from public.users u
        left join public.plan_entitlements pe on pe.key = u.plan
       where u.id = v_endpoint.user_id;

      if not found then
        return jsonb_build_object('status', 'not_found');
      end if;

      -- Free user with expired or unstarted period: start a new one. When
      -- concurrent captures race here, one starts the period and the others
      -- find no row to update once its lock is released; they carry on with
      -- the period it started instead of answering quota_exceeded.
      if v_user.quota_period = 'day' and (v_user.period_end is null or v_user.period_end <= now()) then
        select remaining, quota_limit, period_end_ts into v_period
          from public.start_free_period(v_endpoint.user_id);

        -- Refresh user row after period reset
        select u.id, u.plan, u.request_limit, u.requests_used, u.period_end, u.credit_requests,
               u.overage_active, pe.quota_period
          into v_user
          from public.users u
          left join public.plan_entitlements pe on pe.key = u.plan
         where u.id = v_endpoint.user_id;
      end if;

      -- Atomic quota check + decrement
      select remaining, quota_limit, period_end_ts into v_quota
        from public.check_and_decrement_quota(v_endpoint.user_id, 1);
      v_included := found;

      -- Past the allowance (plan plus recurring blocks): a one-time block,
      -- then overage, before quota_exceeded.
      if not v_included and (v_user.credit_requests > 0 or v_user.overage_active) then
        v_extra := public.take_extra_request(v_endpoint.user_id, null);
      end if;

      if not v_included and v_extra is null then
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
    id, endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key, query_raw,
    object_prefix
  ) values (
    coalesce(p_request_id, gen_random_uuid()),
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key,
    nullif(left(p_query_raw, 8192), ''), p_object_prefix
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
  text, boolean, integer, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text, uuid, text
) to service_role;

commit;

-- 6. check_email_recipient(): base is 00065, mirroring the above (the daily
-- period comes from the entitlements).
create or replace function public.check_email_recipient(p_slug text)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_endpoint record;
  v_team     record;
  v_user     record;
begin
  select id, user_id, expires_at
    into v_endpoint
    from public.endpoints
   where slug = p_slug;

  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_endpoint.expires_at is not null and v_endpoint.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'endpoint_id', v_endpoint.id);
  end if;

  if v_endpoint.user_id is null then
    return jsonb_build_object('status', 'guest', 'endpoint_id', v_endpoint.id);
  end if;

  select t.id, t.requests_used, t.request_limit, t.block_requests
    into v_team
    from public.team_endpoints te
    join public.teams t on t.id = te.team_id
   where te.endpoint_id = v_endpoint.id
     and t.subscription_status is not null
   order by te.shared_at asc
   limit 1;

  if v_team.id is not null then
    if v_team.requests_used >= v_team.request_limit + v_team.block_requests
       and not public.has_extra_request(null, v_team.id) then
      return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
    end if;
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  select u.plan, u.request_limit, u.block_requests, u.requests_used, u.period_end,
         pe.quota_period
    into v_user
    from public.users u
    left join public.plan_entitlements pe on pe.key = u.plan
   where u.id = v_endpoint.user_id;

  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_user.quota_period = 'day' and (v_user.period_end is null or v_user.period_end <= now()) then
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  if v_user.requests_used + 1 > v_user.request_limit + v_user.block_requests
     and not public.has_extra_request(v_endpoint.user_id, null) then
    return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
  end if;

  return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
end;
$$;

revoke all on function public.check_email_recipient(text) from public, anon, authenticated;
grant execute on function public.check_email_recipient(text) to service_role;

-- 7. Extra requests need the request_addons entitlement rather than Pro by
-- name (base is 00065; only that condition changes).
-- Spends one request past the allowance: a one-time block first, then
-- overage while the period's maximum allows. Returns 'credit', 'overage' or
-- null. Called by capture_webhook() only after the allowance refused.
create or replace function public.take_extra_request(p_user_id uuid, p_team_id uuid)
returns text
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_team_id is not null then
    update public.teams
       set credit_requests = credit_requests - 1
     where id = p_team_id
       and subscription_status is not null
       and credit_requests > 0;
    if found then
      return 'credit';
    end if;

    update public.teams
       set overage_used = case
             when overage_period_start is not distinct from period_start then overage_used + 1
             else 1
           end,
           overage_period_start = period_start,
           overage_total = overage_total + 1
     where id = p_team_id
       and subscription_status is not null
       and overage_active
       and period_end > now()
       and case
             when overage_period_start is not distinct from period_start then overage_used
             else 0
           end < overage_max;
    if found then
      return 'overage';
    end if;
    return null;
  end if;

  -- One-time blocks outlive the plan they were bought on.
  update public.users
     set credit_requests = credit_requests - 1
   where id = p_user_id
     and credit_requests > 0;
  if found then
    return 'credit';
  end if;

  update public.users
     set overage_used = case
           when overage_period_start is not distinct from period_start then overage_used + 1
           else 1
         end,
         overage_period_start = period_start,
         overage_total = overage_total + 1
   where id = p_user_id
     and exists (select 1 from public.plan_entitlements pe
                  where pe.key = plan and pe.request_addons)
     and overage_active
     and period_end > now()
     and case
           when overage_period_start is not distinct from period_start then overage_used
           else 0
         end < overage_max;
  if found then
    return 'overage';
  end if;
  return null;
end;
$$;

-- Read-only twin of take_extra_request(), for check_email_recipient().
create or replace function public.has_extra_request(p_user_id uuid, p_team_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select case
    when p_team_id is not null then exists (
      select 1 from public.teams t
       where t.id = p_team_id
         and t.subscription_status is not null
         and (t.credit_requests > 0
              or (t.overage_active
                  and t.period_end > now()
                  and case
                        when t.overage_period_start is not distinct from t.period_start then t.overage_used
                        else 0
                      end < t.overage_max))
    )
    else exists (
      select 1 from public.users u
       where u.id = p_user_id
         and (u.credit_requests > 0
              or (exists (select 1 from public.plan_entitlements pe
                           where pe.key = u.plan and pe.request_addons)
                  and u.overage_active
                  and u.period_end > now()
                  and case
                        when u.overage_period_start is not distinct from u.period_start then u.overage_used
                        else 0
                      end < u.overage_max))
    )
  end
$$;

-- Copies the live add-on subscriptions onto the account row, where captures
-- read them. Blocks and overage need the plan: a free account or an inactive
-- team gets neither, whatever Polar still shows. Both pause while a payment
-- is failing (past_due), and a subscription whose period ended over two days
-- ago without a renewal from Polar no longer counts, so a lost webhook cannot
-- keep granting blocks indefinitely.
create or replace function public.sync_capacity_account(p_user_id uuid, p_team_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_units   integer;
  v_overage boolean;
begin
  select coalesce(max(s.units), 0)
    into v_units
    from public.capacity_subscriptions s
   where s.kind = 'blocks'
     and s.status in ('active', 'canceled')
     and (s.period_end is null or s.period_end > now() - interval '2 days')
     and (s.user_id = p_user_id or s.team_id = p_team_id);

  select exists (
    select 1
      from public.capacity_subscriptions s
     where s.kind = 'overage'
       and s.status in ('active', 'canceled')
       and (s.period_end is null or s.period_end > now() - interval '2 days')
       and (s.user_id = p_user_id or s.team_id = p_team_id)
  ) into v_overage;

  if p_team_id is not null then
    update public.teams t
       set block_requests = v.blocks,
           overage_active = v.overage
      from (select case when subscription_status is not null
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   subscription_status is not null and v_overage as overage
              from public.teams where id = p_team_id) v
     where t.id = p_team_id
       and (t.block_requests, t.overage_active) is distinct from (v.blocks, v.overage);
  else
    update public.users u
       set block_requests = v.blocks,
           overage_active = v.overage
      from (select case when pe.request_addons
                        then v_units * public.capacity_block_requests() else 0 end as blocks,
                   pe.request_addons and v_overage as overage
              from public.users u0
              join public.plan_entitlements pe on pe.key = u0.plan
             where u0.id = p_user_id) v
     where u.id = p_user_id
       and (u.block_requests, u.overage_active) is distinct from (v.blocks, v.overage);
  end if;
end;
$$;

-- 8a. Search: any plan in plan_entitlements, and the retention cutoff is the
-- plan's days (or the account's grace after a downgrade) instead of "7 days
-- when free". Bodies are 00049's with only those lines changed.
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
  -- The plan's retention, or the account's grace after a downgrade when that
  -- is longer; the hourly cleanup deletes what is older, this hides what it
  -- has not reached yet.
  v_retention_cutoff timestamptz := now() - make_interval(days => greatest(
    coalesce((select pe.retention_days from public.plan_entitlements pe
               where pe.key = coalesce(p_plan, 'pro')), 31),
    coalesce(public.account_retention_days(p_user_id, null), 0)));
  v_q text := nullif(btrim(p_q), '');
  -- Endpoints shared with the caller through a subscribed team. Resolved once
  -- so the shared branch is a plain `endpoint_id = any(...)` index probe.
  v_shared_ids uuid[];
  -- The endpoint a slug names, so slug-scoped searches walk only its rows
  -- through requests_endpoint_time instead of every row the caller can see.
  v_endpoint_id uuid;
begin
  if not exists (select 1 from public.plan_entitlements pe where pe.key = v_plan) then
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
       left join public.plan_entitlements pe on pe.key = u.plan
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
         and (r.team_id is not null or pe.retention_days is null
              or r.received_at >= now() - make_interval(days => pe.retention_days))
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
        v_retention_cutoff, v_shared_ids, null::timestamptz, v_endpoint_id, nullif(btrim(p_kind), '');
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
  -- The plan's retention, or the account's grace after a downgrade when that
  -- is longer; the hourly cleanup deletes what is older, this hides what it
  -- has not reached yet.
  v_retention_cutoff timestamptz := now() - make_interval(days => greatest(
    coalesce((select pe.retention_days from public.plan_entitlements pe
               where pe.key = coalesce(p_plan, 'pro')), 31),
    coalesce(public.account_retention_days(p_user_id, null), 0)));
  v_q text := nullif(btrim(p_q), '');
  v_shared_ids uuid[];
  v_owned integer;
  v_shared integer;
  v_endpoint_id uuid;
begin
  if not exists (select 1 from public.plan_entitlements pe where pe.key = v_plan) then
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
    left join public.plan_entitlements pe on pe.key = u.plan
    where r.endpoint_id = v_endpoint_id
      and (
        (r.user_id = p_user_id
          and (v_retention_cutoff is null or r.team_id is not null or r.received_at >= v_retention_cutoff))
        or (v_endpoint_id = any(v_shared_ids)
          and r.user_id is distinct from p_user_id
          and (r.team_id is not null or pe.retention_days is null
               or r.received_at >= now() - make_interval(days => pe.retention_days)))
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
  left join public.plan_entitlements pe on pe.key = u.plan
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
    and (r.team_id is not null or pe.retention_days is null
         or r.received_at >= now() - make_interval(days => pe.retention_days));

  return coalesce(v_owned, 0) + coalesce(v_shared, 0);
end;
$$;

revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) to service_role;

-- 8b. Daily periods come from the entitlements (base is 00044; only the plan
-- condition changes).
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
    and plan in (select pe.key from public.plan_entitlements pe where pe.quota_period = 'day')
    and (period_end is null or period_end <= now())
  returning
    request_limit - requests_used as remaining,
    request_limit as quota_limit,
    public.users.period_end as period_end_ts;
end;
$$;

-- 9. Period resets: base is 00065. Every paid plan, not only Pro. A plan that
-- ends at the end of its billing period falls back to free and keeps its old
-- retention for seven days (the grace floor), so the next cleanup does not
-- delete a month or more of mail without notice. An annual plan's quota
-- period renews every month from its anchor while the year runs.
create or replace function public.process_billing_period_resets()
returns table(processed integer, downgraded integer, renewed integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  downgraded_count integer := 0;
  renewed_count integer := 0;
  v_free_limit integer;
begin
  select pe.request_limit into v_free_limit
    from public.plan_entitlements pe where pe.key = 'free';

  with downgraded_users as (
    update public.users u
    set
      plan = 'free',
      subscription_status = null,
      request_limit = coalesce(v_free_limit, 50),
      requests_used = 0,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      billing_interval = null,
      billing_period_end = null,
      polar_subscription_id = null,
      -- Add-ons need a plan; one-time blocks stay.
      block_requests = 0,
      overage_active = false
    where u.plan <> 'free'
      and u.cancel_at_period_end = true
      and coalesce(u.billing_period_end, u.period_end) is not null
      and coalesce(u.billing_period_end, u.period_end) <= now()
    returning u.id
  )
  select count(*) into downgraded_count from downgraded_users;

  -- Monthly plans: a fallback for a renewal webhook that has not arrived;
  -- Polar's own period replaces this one when it does.
  with renewed_users as (
    update public.users
    set
      requests_used = 0,
      period_start = period_end,
      period_end = period_end + interval '30 days',
      billing_period_end = case
        when billing_period_end is not null and billing_period_end <= period_end
          then period_end + interval '30 days'
        else billing_period_end
      end
    where plan <> 'free'
      and billing_interval is distinct from 'year'
      and cancel_at_period_end = false
      and period_end is not null
      and period_end <= now()
    returning id
  )
  select count(*) into renewed_count from renewed_users;

  -- Annual plans: the quota period moves to the first monthly boundary after
  -- now() in one pass (a job that was down grants one fresh month, not one
  -- per missed month). The billing period is Polar's and stays.
  with renewed_annual as (
    update public.users u
    set
      requests_used = 0,
      period_start = u.period_end + interval '1 month' * m.n,
      period_end = u.period_end + interval '1 month' * (m.n + 1)
    from (
      select x.id,
             (select max(g)
                from generate_series(0, 1200) g
               where x.period_end + interval '1 month' * g <= now()) as n
        from public.users x
       where x.plan <> 'free'
         and x.billing_interval = 'year'
         and x.period_end is not null
         and x.period_end <= now()
    ) m
    where u.id = m.id
      and not (u.cancel_at_period_end and coalesce(u.billing_period_end, u.period_end) <= now())
    returning u.id
  )
  select renewed_count + count(*) into renewed_count from renewed_annual;

  with deactivated_teams as (
    update public.teams t
    set
      subscription_status = null,
      polar_subscription_id = null,
      cancel_at_period_end = false,
      period_start = null,
      period_end = null,
      business = false,
      block_requests = 0,
      overage_active = false
    where t.subscription_status is not null
      and t.cancel_at_period_end = true
      and t.period_end is not null
      and t.period_end <= now()
    returning t.id
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

  -- Add-ons whose period ended over two days ago without a renewal from
  -- Polar stop counting (sync_capacity_account ignores them; it writes only
  -- what changed).
  perform public.sync_capacity_account(s.user_id, s.team_id)
     from public.capacity_subscriptions s
    where s.status is not null
      and s.period_end < now() - interval '2 days';

  return query
  select downgraded_count + renewed_count, downgraded_count, renewed_count;
end;
$$;

-- 10. Quota emails: nothing here. claim_quota_exhausted_users() is 00077's
-- (applied before this file in production), which already sends Free, the
-- one plan on a daily period, at most one email a week, and every paid plan
-- one a billing period.

-- 11. Retention. Deletes in batches of p_batch rows through the indexes that
-- already exist (requests_user_time, requests_team, requests_endpoint_time,
-- requests_received_at), at most p_max_rows per run; the next run carries on.
-- Order: everything past the longest retention any plan has; guests'
-- rows past 31 days; each account's personal rows past its retention; each
-- team's billed rows past the team's; each endpoint's rows past its own
-- shorter setting. Returns the rows deleted.
create or replace function public.cleanup_expired_requests(
  p_batch    integer default 5000,
  p_max_rows integer default 500000
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_batch   integer := least(greatest(coalesce(p_batch, 5000), 1), 50000);
  v_budget  integer := greatest(coalesce(p_max_rows, 500000), 0);
  v_total   integer := 0;
  v_count   integer;
  v_max     integer;
  v_account record;
begin
  select max(pe.retention_days) into v_max from public.plan_entitlements pe;
  v_max := greatest(coalesce(v_max, 31),
                    coalesce((select max(u.retention_floor_days) from public.users u
                               where u.retention_floor_until > now()), 0),
                    coalesce((select max(t.retention_floor_days) from public.teams t
                               where t.retention_floor_until > now()), 0));

  -- a. Past the longest retention anyone has.
  loop
    exit when v_total >= v_budget;
    delete from public.requests
     where ctid = any(array(
       select r.ctid from public.requests r
        where r.received_at < now() - make_interval(days => v_max)
        limit least(v_batch, v_budget - v_total)));
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
    exit when v_count < least(v_batch, v_budget - v_total + v_count);
  end loop;

  -- b. Guest rows (no owner) keep the 31 days they always had; their
  -- endpoints expire long before.
  loop
    exit when v_total >= v_budget;
    delete from public.requests
     where ctid = any(array(
       select r.ctid from public.requests r
        where r.user_id is null
          and r.received_at < now() - interval '31 days'
        limit least(v_batch, v_budget - v_total)));
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
    exit when v_count < least(v_batch, v_budget - v_total + v_count);
  end loop;

  -- c. Personal rows, per account whose retention is shorter than v_max.
  for v_account in
    select u.id, public.account_retention_days(u.id, null) as days
      from public.users u
  loop
    continue when v_account.days >= v_max;
    loop
      exit when v_total >= v_budget;
      delete from public.requests
       where ctid = any(array(
         select r.ctid from public.requests r
          where r.user_id = v_account.id
            and r.team_id is null
            and r.received_at < now() - make_interval(days => v_account.days)
          limit least(v_batch, v_budget - v_total)));
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
      exit when v_count < least(v_batch, v_budget - v_total + v_count);
    end loop;
  end loop;

  -- d. Team-billed rows, per team.
  for v_account in
    select t.id, public.account_retention_days(null, t.id) as days
      from public.teams t
  loop
    continue when v_account.days >= v_max;
    loop
      exit when v_total >= v_budget;
      delete from public.requests
       where ctid = any(array(
         select r.ctid from public.requests r
          where r.team_id = v_account.id
            and r.received_at < now() - make_interval(days => v_account.days)
          limit least(v_batch, v_budget - v_total)));
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
      exit when v_count < least(v_batch, v_budget - v_total + v_count);
    end loop;
  end loop;

  -- e. Endpoints with a shorter retention of their own.
  for v_account in
    select e.id, e.retention_days as days
      from public.endpoints e
     where e.retention_days is not null
  loop
    loop
      exit when v_total >= v_budget;
      delete from public.requests
       where ctid = any(array(
         select r.ctid from public.requests r
          where r.endpoint_id = v_account.id
            and r.received_at < now() - make_interval(days => v_account.days)
          limit least(v_batch, v_budget - v_total)));
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
      exit when v_count < least(v_batch, v_budget - v_total + v_count);
    end loop;
  end loop;

  return v_total;
end;
$$;

-- "Deliver, then delete": an endpoint's requests go once every delivery is
-- settled. A minute's wait lets the dashboard show them arrive.
create or replace function public.cleanup_delivered_requests(p_limit integer default 1000)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.requests
   where ctid = any(array(
     select r.ctid
       from public.endpoints e
       join public.requests r on r.endpoint_id = e.id
      where e.delete_after_delivery
        and r.received_at < now() - interval '1 minute'
        and not exists (
          select 1 from public.email_deliveries d
           where d.request_id = r.id
             and d.status = 'pending')
      limit least(greatest(coalesce(p_limit, 1000), 1), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create index if not exists endpoints_delete_after_delivery
  on public.endpoints (id) where delete_after_delivery;

-- 12. Grants: service role only.
revoke all on function public.account_entitlements(uuid, uuid) from public, anon, authenticated;
revoke all on function public.account_retention_days(uuid, uuid) from public, anon, authenticated;
revoke all on function public.queue_request_objects_deletion() from public, anon, authenticated;
revoke all on function public.claim_storage_deletions(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_storage_deletions(bigint[]) from public, anon, authenticated;
revoke all on function public.take_extra_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.has_extra_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sync_capacity_account(uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_free_period(uuid) from public, anon, authenticated;
revoke all on function public.process_billing_period_resets() from public, anon, authenticated;
revoke all on function public.cleanup_expired_requests(integer, integer) from public, anon, authenticated;
revoke all on function public.cleanup_delivered_requests(integer) from public, anon, authenticated;

grant execute on function public.account_entitlements(uuid, uuid) to service_role;
grant execute on function public.account_retention_days(uuid, uuid) to service_role;
grant execute on function public.claim_storage_deletions(integer, integer) to service_role;
grant execute on function public.complete_storage_deletions(bigint[]) to service_role;
grant execute on function public.take_extra_request(uuid, uuid) to service_role;
grant execute on function public.has_extra_request(uuid, uuid) to service_role;
grant execute on function public.sync_capacity_account(uuid, uuid) to service_role;
grant execute on function public.start_free_period(uuid) to service_role;
grant execute on function public.process_billing_period_resets() to service_role;
grant execute on function public.cleanup_expired_requests(integer, integer) to service_role;
grant execute on function public.cleanup_delivered_requests(integer) to service_role;


-- Guests' rows, for the retention cleanup's 31-day step. An invalid leftover
-- of an interrupted run is dropped first, as in 00034.
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'requests_guest_time'
       and not i.indisvalid
  ) then
    execute 'drop index public.requests_guest_time';
  end if;
end $$;

create index concurrently if not exists requests_guest_time
  on public.requests (received_at) where user_id is null;

-- 13. Validate the constraints added NOT VALID above, outside the transaction.
alter table public.users validate constraint users_plan_check;
alter table public.users validate constraint users_billing_interval_check;
alter table public.users validate constraint users_retention_floor_check;
alter table public.teams validate constraint teams_retention_floor_check;
alter table public.endpoints validate constraint endpoints_retention_days_check;
alter table public.requests validate constraint requests_object_prefix_check;

-- 14. Jobs: the retention cleanup every 10 minutes (smaller passes, so no
-- single run holds the WAL and the I/O for long) replaces the two daily ones
-- (their functions stay, unscheduled).
select cron.unschedule(jobid) from cron.job
 where jobname in ('cleanup-old-requests-daily', 'cleanup-free-user-requests-daily',
                   'cleanup-expired-requests-hourly', 'cleanup-expired-requests',
                   'cleanup-delivered-requests');

select cron.schedule(
  'cleanup-expired-requests',
  '*/10 * * * *',
  $$select public.cleanup_expired_requests(5000, 100000)$$
);

select cron.schedule(
  'cleanup-delivered-requests',
  '* * * * *',
  $$select public.cleanup_delivered_requests()$$
);

notify pgrst, 'reload schema';
