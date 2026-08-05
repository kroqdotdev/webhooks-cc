-- ============================================================================
-- Migration 00033: Team seat-based billing (Polar)
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

alter table public.requests
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists requests_team
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
      -- Pooled quota: atomic conditional increment on the single team row
      update public.teams
         set requests_used = requests_used + 1
       where id = v_team.id
         and requests_used < request_limit;

      if not found then
        v_retry_after := null;
        if v_team.period_end is not null and v_team.period_end > now() then
          v_retry_after := extract(epoch from (v_team.period_end - now()))::bigint * 1000;
        end if;

        return jsonb_build_object(
          'status', 'quota_exceeded',
          'retry_after', v_retry_after
        );
      end if;

      v_billing_team_id := v_team.id;
    else
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

-- Reload PostgREST schema cache so the Part 1 columns are visible via REST API
notify pgrst, 'reload schema';
