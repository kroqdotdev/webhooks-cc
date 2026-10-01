-- ============================================================================
-- Migration 00041: audit events and daily per-endpoint usage rollups
--
-- Two gaps showed up while investigating the first paying team:
--
--  1. The web app logs only failures. Invites, accepts, member removals, seat
--     changes, and Polar webhook deliveries leave no trace when they succeed,
--     so "what happened to this member" could only be pieced together from
--     current table state plus Polar's own delivery history.
--
--     audit_events records each state-changing account, team, billing, and
--     endpoint action, written by the web app (lib/audit.ts). It holds ids,
--     not foreign keys, so history survives the deletion of the users, teams,
--     and endpoints it describes. Volume is human-scale (a handful of rows
--     per user action), and prune_audit_events() drops rows older than a
--     year every night.
--
--  2. requests is pruned by plan retention, so usage history older than about
--     a month is gone, and there was no way to see request volume per month
--     or tell "stopped sending" from "hit the quota".
--
--     endpoint_daily_stats keeps one row per endpoint per UTC day with the
--     captured count, how many of those were team-billed, quota rejections,
--     and bytes. capture_webhook() upserts it on every capture and every
--     quota rejection. It stores counts only, never payloads, so it stays
--     tiny (one row per active endpoint per day) and is kept indefinitely.
--     endpoint_id is deliberately not a foreign key so the history outlives
--     endpoint deletion; user_id and team_id are set null when those rows go.
--
-- Hot-path cost: one single-row upsert per capture or rejection, the same
-- contention profile as the existing endpoints.request_count increment.
--
-- Backfill: days before today (UTC) are rebuilt from the requests still
-- retained. Rejections were never stored, so backfilled rows show 0 for them,
-- and today's row only counts captures made after this migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. audit_events
-- ----------------------------------------------------------------------------

create table if not exists public.audit_events (
  id              bigint generated always as identity primary key,
  occurred_at     timestamptz not null default now(),
  actor_type      text not null check (actor_type in ('user', 'polar', 'system')),
  actor_user_id   uuid,
  via             text check (via in ('session', 'api_key')),
  user_agent      text check (char_length(user_agent) <= 256),
  action          text not null check (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  outcome         text not null default 'ok' check (outcome in ('ok', 'refused', 'error')),
  team_id         uuid,
  target_user_id  uuid,
  target_id       text check (char_length(target_id) <= 128),
  metadata        jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096)
);

create index if not exists audit_events_occurred_at
  on public.audit_events (occurred_at);
create index if not exists audit_events_team
  on public.audit_events (team_id, occurred_at desc) where team_id is not null;
create index if not exists audit_events_actor
  on public.audit_events (actor_user_id, occurred_at desc) where actor_user_id is not null;
create index if not exists audit_events_target_user
  on public.audit_events (target_user_id, occurred_at desc) where target_user_id is not null;

-- Service role only. The instance's default table privileges grant anon and
-- authenticated DML on new tables; revoke them and keep RLS deny-all.
alter table public.audit_events enable row level security;

-- Rows are append-only: the service role may read, insert, and prune, never
-- update.
revoke all on table public.audit_events from public, anon, authenticated, service_role;
grant select, insert, delete on table public.audit_events to service_role;

create or replace function public.prune_audit_events()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.audit_events where occurred_at < now() - interval '1 year';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.prune_audit_events() from public, anon, authenticated;
grant execute on function public.prune_audit_events() to service_role;

select cron.schedule(
  'prune-audit-events-daily',
  '17 3 * * *',
  'select public.prune_audit_events();'
);

-- ----------------------------------------------------------------------------
-- 2. endpoint_daily_stats
-- ----------------------------------------------------------------------------

create table if not exists public.endpoint_daily_stats (
  endpoint_id     uuid not null,
  day             date not null,
  user_id         uuid references public.users(id) on delete set null,
  team_id         uuid references public.teams(id) on delete set null,
  captured        integer not null default 0 check (captured >= 0),
  team_billed     integer not null default 0 check (team_billed >= 0),
  quota_rejected  integer not null default 0 check (quota_rejected >= 0),
  bytes           bigint not null default 0 check (bytes >= 0),
  primary key (endpoint_id, day)
);

create index if not exists endpoint_daily_stats_user
  on public.endpoint_daily_stats (user_id, day) where user_id is not null;
create index if not exists endpoint_daily_stats_team
  on public.endpoint_daily_stats (team_id, day) where team_id is not null;
create index if not exists endpoint_daily_stats_day
  on public.endpoint_daily_stats (day);

alter table public.endpoint_daily_stats enable row level security;
-- Written only by capture_webhook() (as its owner). The service role reads,
-- and may delete for test cleanup.
revoke all on table public.endpoint_daily_stats from public, anon, authenticated, service_role;
grant select, delete on table public.endpoint_daily_stats to service_role;

-- team_id keeps the most recent billing team seen that day, so a day that was
-- partly team-billed still names the team; team_billed carries the split.
create or replace function public.bump_endpoint_daily_stats(
  p_endpoint_id    uuid,
  p_user_id        uuid,
  p_team_id        uuid,
  p_day            date,
  p_captured       integer,
  p_team_billed    integer,
  p_quota_rejected integer,
  p_bytes          bigint
)
returns void
language sql
set search_path = ''
as $$
  insert into public.endpoint_daily_stats as s (
    endpoint_id, day, user_id, team_id, captured, team_billed, quota_rejected, bytes
  ) values (
    p_endpoint_id, p_day, p_user_id, p_team_id, p_captured, p_team_billed, p_quota_rejected, p_bytes
  )
  on conflict (endpoint_id, day) do update
     set captured       = s.captured + excluded.captured,
         team_billed    = s.team_billed + excluded.team_billed,
         quota_rejected = s.quota_rejected + excluded.quota_rejected,
         bytes          = s.bytes + excluded.bytes,
         user_id        = coalesce(excluded.user_id, s.user_id),
         team_id        = coalesce(excluded.team_id, s.team_id);
$$;

revoke all on function public.bump_endpoint_daily_stats(
  uuid, uuid, uuid, date, integer, integer, integer, bigint
) from public, anon, authenticated;
grant execute on function public.bump_endpoint_daily_stats(
  uuid, uuid, uuid, date, integer, integer, integer, bigint
) to service_role;

-- ----------------------------------------------------------------------------
-- 3. capture_webhook(): unchanged from 00034 except the daily-stats upserts
--    on the success path and on each quota_exceeded return.
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
    select request_count into v_quota
      from public.check_and_increment_ephemeral(v_endpoint.id);

    if not found then
      perform public.bump_endpoint_daily_stats(v_endpoint.id, null, null, v_day, 0, 0, 1, 0);
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

          perform public.bump_endpoint_daily_stats(
            v_endpoint.id, v_endpoint.user_id, v_team.id, v_day, 0, 0, 1, 0
          );
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
          perform public.bump_endpoint_daily_stats(
            v_endpoint.id, v_endpoint.user_id, null, v_day, 0, 0, 1, 0
          );
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

        perform public.bump_endpoint_daily_stats(
          v_endpoint.id, v_endpoint.user_id, null, v_day, 0, 0, 1, 0
        );
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
    'signing_header', v_endpoint.signing_header
  );
end;
$$;

revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) to service_role;

-- ----------------------------------------------------------------------------
-- 4. Backfill completed days from the requests still retained
-- ----------------------------------------------------------------------------

insert into public.endpoint_daily_stats (
  endpoint_id, day, user_id, team_id, captured, team_billed, quota_rejected, bytes
)
select r.endpoint_id,
       (r.received_at at time zone 'UTC')::date,
       (array_agg(r.user_id) filter (where r.user_id is not null))[1],
       (array_agg(r.team_id order by r.received_at desc) filter (where r.team_id is not null))[1],
       count(*),
       count(r.team_id),
       0,
       coalesce(sum(r.size), 0)
  from public.requests r
 where r.received_at < (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
 group by r.endpoint_id, (r.received_at at time zone 'UTC')::date
on conflict (endpoint_id, day) do nothing;

notify pgrst, 'reload schema';
