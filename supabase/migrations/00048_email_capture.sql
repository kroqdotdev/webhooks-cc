-- ============================================================================
-- Migration 00048: email capture
--
-- Endpoints owned by an account receive email at {slug}@mailhooks.cc. The MX
-- host speaks SMTP and hands each accepted message to the receiver, which
-- stores it as a request with kind = 'email'. An email is an ordinary request:
-- it uses the same quota, period, team pool, counters and realtime signals as
-- an HTTP capture, so capture_webhook() stays the single place that bills.
--
-- 1. requests.kind ('http' or 'email'), requests.email (the parsed message:
--    addresses, subject, text and HTML parts, attachment list, SMTP and
--    authentication details) and requests.dedupe_key (the message hash).
--    All three are cheap to add: a constant default is stored in the
--    catalog, not written to existing rows. They are added in one ALTER so
--    the table is locked once.
-- 2. capture_webhook() gains p_kind, p_email, p_dedupe_key, p_retry and
--    p_size, all defaulted, so the receiver's current 10-argument call keeps
--    working. Email to an endpoint without an owner (guest or ephemeral)
--    returns 'not_allowed' before any quota is touched: guest captures are
--    readable by anyone who knows the slug, so guests get no address.
--    A delivery the MX host marks as a retry returns 'duplicate' when an
--    earlier attempt already stored the same message on that endpoint, so a
--    sender's retry is never billed twice. Only retries are checked: the same
--    message sent again on purpose is a new capture.
-- 3. check_email_recipient() answers the MX host's RCPT question without side
--    effects, mirroring capture_webhook()'s billing selection. The capture
--    stays the authoritative quota check.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columns
-- ----------------------------------------------------------------------------

-- One ALTER, so captures queue behind a single short exclusive lock. The
-- CHECK is added NOT VALID and validated separately, which scans without
-- blocking inserts. Skipped entirely on a re-run.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'requests_kind_valid'
      and conrelid = 'public.requests'::regclass
  ) then
    alter table public.requests
      add column if not exists kind text not null default 'http',
      add column if not exists email jsonb,
      add column if not exists dedupe_key text,
      add constraint requests_kind_valid check (kind in ('http', 'email')) not valid;
  end if;
end $$;

alter table public.requests validate constraint requests_kind_valid;

-- Retry lookups. Partial: only email rows carry a key, so HTTP captures never
-- touch this index.
create index concurrently if not exists requests_endpoint_dedupe
  on public.requests (endpoint_id, dedupe_key)
  where dedupe_key is not null;

-- ----------------------------------------------------------------------------
-- 2. capture_webhook with kind, email and retry protection
--
-- Two overloads whose shorter argument list matches a 10-argument call would
-- make that call ambiguous, so the old signature is dropped and the new one
-- created in one transaction: a concurrent capture sees one or the other,
-- never neither. The legacy 9-argument overload from 00018 is dropped too if
-- it survives anywhere. Apart from the kind check, the guest check, the retry
-- check, the size override and the new columns, the body is unchanged from
-- 00044.
-- ----------------------------------------------------------------------------

begin;

drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz
);
drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
);
drop function if exists public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb
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
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer
) to service_role;

commit;

-- ----------------------------------------------------------------------------
-- 3. check_email_recipient
--
-- Answers whether a capture for p_slug would be accepted right now, without
-- capturing, starting a period or touching any counter. Mirrors the billing
-- selection in capture_webhook(); keep the two in step. A Free account whose
-- period has ended or not started counts as available, because the capture
-- starts a new period.
-- ----------------------------------------------------------------------------

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

  select t.id, t.requests_used, t.request_limit
    into v_team
    from public.team_endpoints te
    join public.teams t on t.id = te.team_id
   where te.endpoint_id = v_endpoint.id
     and t.subscription_status is not null
   order by te.shared_at asc
   limit 1;

  if v_team.id is not null then
    if v_team.requests_used >= v_team.request_limit then
      return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
    end if;
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  select plan, request_limit, requests_used, period_end
    into v_user
    from public.users
   where id = v_endpoint.user_id;

  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_user.plan = 'free' and (v_user.period_end is null or v_user.period_end <= now()) then
    return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
  end if;

  if v_user.requests_used + 1 > v_user.request_limit then
    return jsonb_build_object('status', 'over_quota', 'endpoint_id', v_endpoint.id);
  end if;

  return jsonb_build_object('status', 'ok', 'endpoint_id', v_endpoint.id);
end;
$$;

revoke all on function public.check_email_recipient(text) from public, anon, authenticated;
grant execute on function public.check_email_recipient(text) to service_role;

notify pgrst, 'reload schema';
