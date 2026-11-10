-- ============================================================================
-- 00092: live captures (whk tunnel --live)
-- ============================================================================
-- An endpoint with an open live session (endpoints.live_session_id, 00091)
-- has its HTTP captures relayed by the receiver to the session's tunnel, so
-- the sender gets the local app's own answer. The capture itself is
-- unchanged: it is stored, billed and queued for forwarding first, and only
-- then relayed.
--
-- capture_webhook(): 00090's body, with the same signature, also returning
--   `endpoint_id` and `live`. `live` is true only for an HTTP capture whose
--   endpoint names a live session that is still open (one primary key read
--   of tunnel_shares, and only when the endpoint names one), or whose session
--   dropped less than two minutes ago (endpoints.live_grace_until, read from
--   the endpoint row already loaded). Email is never
--   live: no sender waits for its answer. The receiver of the running
--   release ignores the two new keys, so this applies before or after the
--   release that reads them.
--
-- record_live_response(): what the app answered, written by the receiver
--   after the relay. Sets requests.live_response (status, headers, the first
--   64 KB of the body as UTF-8 text or base64, whether it was cut, how long the
--   app took, and the outcome: answered, or what stood in for an answer:
--   offline, timeout, unreachable, busy, refused) and response_status to the
--   status the sender got, and clears response_rule, since no rule chose a live
--   answer. Values out of range are dropped, never refused.
--
-- requests_broadcast_signature (00043, 00090) also fires when live_response
--   changes, so an open dashboard reads the answer once it is recorded.
--
-- Service role only.
-- ============================================================================

begin;

create or replace function public.capture_webhook(
  p_slug            text,
  p_method          text,
  p_path            text,
  p_headers         jsonb,
  p_body            text,
  p_query_params    jsonb,
  p_content_type    text,
  p_ip              text,
  p_received_at     timestamptz,
  p_body_raw        bytea default null,
  p_kind            text default 'http',
  p_email           jsonb default null,
  p_dedupe_key      text default null,
  p_retry           boolean default false,
  p_size            integer default null,
  p_query_raw       text default null,
  p_request_id      uuid default null,
  p_object_prefix   text default null,
  p_response_status integer default null,
  p_response_rule   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  -- A live capture (00092): the endpoint's open live session, if any.
  v_live            boolean;
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
         agent_registration_id,
         live_session_id,
         live_grace_until,
         -- Read only for email, so an HTTP capture never loads the layouts.
         case when v_kind = 'email' then jsonb_array_length(layouts) > 0 else false end
           as has_layouts
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

  -- response_status and response_rule: what the receiver answered (00090).
  -- Out-of-range values are dropped rather than refused: a capture must never
  -- fail over what was recorded about its answer.
  insert into public.requests (
    id, endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key, query_raw,
    object_prefix, response_status, response_rule
  ) values (
    coalesce(p_request_id, gen_random_uuid()),
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key,
    nullif(left(p_query_raw, 8192), ''), p_object_prefix,
    case when p_response_status between 100 and 599 then p_response_status::smallint end,
    nullif(left(p_response_rule, 200), '')
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  -- (the count and when mail last arrived, in one update of the row)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    update public.endpoints
       set request_count = request_count + 1,
           last_email_at = case when v_kind = 'email' then now() else last_email_at end
     where id = v_endpoint.id;
  end if;

  -- 5b. Forwarding: queue one delivery per enabled destination that takes
  -- this kind, in the capture's own transaction, so a captured request is
  -- never lost before it is queued; the web app's worker sends them
  -- (claim_email_deliveries) and checks each destination's filter there.
  -- A destination switched off while this runs leaves at most a row the
  -- claim settles.
  -- An email to an endpoint with layouts is parsed first; the parse job is
  -- the durable queue entry, and complete_request_parse() queues the
  -- deliveries once the parsed result is stored.
  if v_kind = 'email' and v_endpoint.has_layouts then
    insert into public.request_parses (request_id, endpoint_id)
    values (v_request_id, v_endpoint.id);
  else
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
  end if;

  perform public.bump_endpoint_daily_stats(
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, v_day,
    1, (v_billing_team_id is not null)::integer, 0, v_size,
    (v_kind = 'email')::integer
  );

  -- 5c. Live (00092): an HTTP capture of an endpoint whose live session is
  -- still open is relayed by the receiver to the session's tunnel. One
  -- primary key read, only when the endpoint names a session.
  v_live := false;
  if v_kind = 'http' and v_endpoint.live_session_id is not null then
    select true into v_live
      from public.tunnel_shares s
     where s.id = v_endpoint.live_session_id
       and s.kind = 'live'
       and s.ended_at is null;
    v_live := coalesce(v_live, false);
  end if;
  -- A session that just dropped (00091, live_grace_until): still live for two
  -- minutes, so the sender gets the edge's 502 while the CLI reconnects
  -- instead of the mock's 200. Read from the row already loaded.
  if v_kind = 'http' and not v_live and v_endpoint.live_grace_until > now() then
    v_live := true;
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
    -- Notifications are destinations now (00063); the receiver sends none.
    'notification_url', null::text,
    'endpoint_name', v_endpoint.name,
    'signing_provider', v_endpoint.signing_provider,
    'signing_secret_encrypted', encode(v_endpoint.signing_secret_encrypted, 'base64'),
    'signing_header', v_endpoint.signing_header,
    'billing_key', v_billing_key,
    'endpoint_id', v_endpoint.id,
    'live', v_live
  );
end;
$$;

-- create or replace takes a lighter lock than drop and create: reads go on.
create or replace trigger requests_broadcast_signature
  after update of signature_verified, signature_error, signing_provider,
                  response_status, response_rule, live_response on public.requests
  for each row
  when (
    new.user_id is not null
    and (
      old.signature_verified is distinct from new.signature_verified
      or old.signature_error is distinct from new.signature_error
      or old.signing_provider is distinct from new.signing_provider
      or old.response_status is distinct from new.response_status
      or old.response_rule is distinct from new.response_rule
      or old.live_response is distinct from new.live_response
    )
  )
  execute function public.broadcast_request_change();

create or replace function public.record_live_response(
  p_request_id     uuid,
  p_status         integer,
  p_headers        jsonb,
  p_body           text,
  p_body_truncated boolean,
  p_ms             integer,
  p_body_encoding  text default 'utf8',
  p_outcome        text default 'answered'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.requests
     set live_response = jsonb_build_object(
           'status', case when p_status between 100 and 599 then p_status end,
           'headers', case when jsonb_typeof(p_headers) = 'object' then p_headers
                           else '{}'::jsonb end,
           'body', coalesce(p_body, ''),
           'bodyTruncated', coalesce(p_body_truncated, false),
           'bodyEncoding', case when p_body_encoding = 'base64' then 'base64' else 'utf8' end,
           'ms', case when p_ms >= 0 then p_ms end,
           'outcome', case when p_outcome in ('answered', 'offline', 'timeout', 'unreachable', 'busy', 'refused')
                           then p_outcome else 'unreachable' end
         ),
         response_status = case when p_status between 100 and 599 then p_status::smallint end,
         response_rule = null
   where id = p_request_id
     and kind = 'http';
  return found;
end;
$$;

revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text, uuid, text, integer, text
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text, uuid, text, integer, text
) to service_role;

revoke all on function public.record_live_response(
  uuid, integer, jsonb, text, boolean, integer, text, text
) from public, anon, authenticated;
grant execute on function public.record_live_response(
  uuid, integer, jsonb, text, boolean, integer, text, text
) to service_role;

commit;
