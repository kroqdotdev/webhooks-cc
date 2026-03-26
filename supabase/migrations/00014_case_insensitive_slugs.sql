-- ============================================================================
-- Migration 00014: Case-insensitive endpoint slugs
--
-- Makes endpoint slug lookups case-insensitive by:
-- 1. Lowercasing all existing slugs
-- 2. Updating capture_webhook() to normalize input slugs
--
-- New slugs are generated as lowercase-only by the application layer.
-- ============================================================================

-- 1. Lowercase all existing endpoint slugs.
-- nanoid-generated slugs are random, so case-only collisions are near-impossible.
-- The unique index will catch any conflict and fail the migration safely.
update public.endpoints set slug = lower(slug) where slug != lower(slug);

-- 2. Replace the unique index with a case-insensitive functional index.
-- Prevents mixed-case slugs from bypassing uniqueness via direct SQL inserts.
drop index if exists public.endpoints_slug;
create unique index endpoints_slug on public.endpoints (lower(slug));

-- 3. Update capture_webhook to normalize slug input
create or replace function public.capture_webhook(
  p_slug        text,
  p_method      text,
  p_path        text,
  p_headers     jsonb,
  p_body        text,
  p_query_params jsonb,
  p_content_type text,
  p_ip          text,
  p_received_at timestamptz
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
begin
  -- Normalize slug to lowercase for case-insensitive lookup
  v_slug := lower(p_slug);

  -- 1. Look up endpoint by slug
  select id, user_id, is_ephemeral, expires_at, mock_response, request_count
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
        -- Period start failed (shouldn't happen, but handle gracefully)
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
  -- else: owned endpoint with null user_id but not ephemeral — allow through (no quota)

  -- 4. Insert the request
  v_size := coalesce(octet_length(p_body), 0);

  insert into public.requests (
    endpoint_id, user_id, method, path, headers, body,
    query_params, content_type, ip, size, received_at
  ) values (
    v_endpoint.id, v_endpoint.user_id, p_method, p_path, p_headers, p_body,
    p_query_params, p_content_type, p_ip, v_size, p_received_at
  );

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    perform public.increment_endpoint_request_count(v_endpoint.id, 1);
  end if;

  -- User requests_used already incremented by check_and_decrement_quota

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
    'mock_response', v_mock,
    'retry_after', null::bigint
  );
end;
$$;
