-- 00076: search hides rows past an endpoint's own retention.
--
-- An endpoint can keep its requests fewer days than its plan
-- (endpoints.retention_days, migration 00067), and cleanup_expired_requests()
-- deletes them every 10 minutes, team-billed rows too. Until it does, reads
-- hide them like rows past the plan's retention: the request routes in the
-- web app, and here search_requests() and search_requests_count(), whose
-- bodies are otherwise those of migration 00067.
--
-- Re-runnable: create or replace only.

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
         and (e.retention_days is null or r.received_at >= now() - make_interval(days => e.retention_days))
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
         and (e.retention_days is null or r.received_at >= now() - make_interval(days => e.retention_days))
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
      and (v_to is null or r.received_at <= v_to)
      and (e.retention_days is null or r.received_at >= now() - make_interval(days => e.retention_days));

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
    and (v_retention_cutoff is null or r.team_id is not null or r.received_at >= v_retention_cutoff)
    and (e.retention_days is null or r.received_at >= now() - make_interval(days => e.retention_days));

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
         or r.received_at >= now() - make_interval(days => pe.retention_days))
    and (e.retention_days is null or r.received_at >= now() - make_interval(days => e.retention_days));

  return coalesce(v_owned, 0) + coalesce(v_shared, 0);
end;
$$;

revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text) to service_role;
