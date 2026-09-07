-- ============================================================================
-- Migration 00039: search covers endpoints shared with the caller through teams
--
-- Base is 00034 Part 4 (itself based on 00021). What changes:
--
--  1. Visibility. A row is searchable when the caller owns it (r.user_id) or
--     its endpoint is shared with a subscribed team the caller belongs to.
--     This is the rule resolveEndpointAccess() applies on the request list
--     and stream routes, so a team member who can open a shared endpoint in
--     the dashboard, CLI, SDK, or MCP can now also find its requests by
--     searching. Suspended teams share nothing (getSharedEndpointsForUser()).
--
--  2. Retention. Owned rows keep the caller's personal cutoff with the 00034
--     carve-out for team-billed rows. Rows on shared endpoints get the
--     endpoint OWNER's retention instead (free owner: 7 days unless
--     team-billed; pro owner: none), which is what
--     listRequestsForEndpointByUser() applies when a member reads the same
--     endpoint. Search and the request routes therefore agree on which rows
--     exist.
--
--  3. Plan shape. The two populations are queried as separate branches and
--     combined with UNION ALL, each branch ordered and limited on its own
--     index (requests_user_time for owned rows, requests_endpoint_time for
--     shared rows). A single `user_id = $1 OR endpoint_id IN (...)`
--     predicate was measured to drop both indexes: search fell back to a
--     backward walk of requests_received_at and count to a sequential scan of
--     public.requests, for every caller including users with no teams. The
--     shared branch excludes rows the caller owns so an endpoint shared with
--     the caller's own team is never counted twice.
--
-- Signatures are unchanged, so PostgREST types and lib/supabase/search.ts stay
-- as they are. Both functions are `security definer` over an arbitrary
-- p_user_id, so anon or authenticated execute would be a full read of every
-- user's captured headers and bodies. `create or replace` preserves the
-- existing ACL, and the revoke/grant stanzas are re-issued below regardless.
-- ============================================================================

create or replace function public.search_requests(
  p_user_id uuid,
  p_plan text default null,
  p_slug text default null,
  p_method text default null,
  p_q text default null,
  p_from_ms bigint default null,
  p_to_ms bigint default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_order text default 'desc'
)
returns table(
  id text,
  slug text,
  method text,
  path text,
  headers jsonb,
  body text,
  query_params jsonb,
  content_type text,
  ip text,
  size integer,
  received_at bigint
)
language plpgsql
security definer set search_path = ''
as $$
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
  v_retention_cutoff timestamptz := case
    when v_plan = 'free' then now() - interval '7 days'
    else null
  end;
  v_free_cutoff timestamptz := now() - interval '7 days';
  v_q text := nullif(btrim(p_q), '');
  -- Endpoints shared with the caller through a subscribed team. Resolved once
  -- so the shared branch is a plain `endpoint_id = any(...)` index probe.
  v_shared_ids uuid[];
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct te.endpoint_id), '{}'::uuid[])
  into v_shared_ids
  from public.team_endpoints te
  join public.team_members tm on tm.team_id = te.team_id
  join public.teams t on t.id = te.team_id
  where tm.user_id = p_user_id
    and t.subscription_status is not null;

  return query execute format(
    'with owned as (
       select r.id, e.slug, r.method, r.path, r.headers, r.body, r.query_params,
              r.content_type, r.ip, r.size, r.received_at
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       where r.user_id = $1
         and ($2 is null or e.slug = $2)
         and ($3 is null or $3 = ''ALL'' or r.method = $3)
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
              r.content_type, r.ip, r.size, r.received_at
       from public.requests r
       join public.endpoints e on e.id = r.endpoint_id
       left join public.users u on u.id = e.user_id
       where r.endpoint_id = any($8)
         and r.user_id is distinct from $1
         and ($2 is null or e.slug = $2)
         and ($3 is null or $3 = ''ALL'' or r.method = $3)
         and (
           $4 is null
           or r.path ilike ''%%'' || $4 || ''%%''
           or r.body ilike ''%%'' || $4 || ''%%''
           or r.headers::text ilike ''%%'' || $4 || ''%%''
         )
         and ($5 is null or r.received_at >= $5)
         and ($6 is null or r.received_at <= $6)
         and (r.team_id is not null or u.plan is distinct from ''free'' or r.received_at >= $9)
       order by r.received_at %1$s
       limit %2$s
     )
     select x.id::text, x.slug, x.method, x.path, x.headers,
            nullif(x.body, ''''), x.query_params, nullif(x.content_type, ''''),
            x.ip, x.size,
            floor(extract(epoch from x.received_at) * 1000)::bigint
     from (select * from owned union all select * from shared) x
     order by x.received_at %1$s
     limit %3$s offset %4$s',
    v_order,
    v_limit + v_offset,
    v_limit,
    v_offset
  )
  using p_user_id, nullif(btrim(p_slug), ''), nullif(btrim(p_method), ''), v_q, v_from, v_to,
        v_retention_cutoff, v_shared_ids, v_free_cutoff;
end;
$$;

-- Same two branches, summed, so the result count matches the result pages.
create or replace function public.search_requests_count(
  p_user_id uuid,
  p_plan text default null,
  p_slug text default null,
  p_method text default null,
  p_q text default null,
  p_from_ms bigint default null,
  p_to_ms bigint default null
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_plan text := coalesce(p_plan, 'pro');
  v_slug text := nullif(btrim(p_slug), '');
  v_method text := nullif(btrim(p_method), '');
  v_from timestamptz := case
    when p_from_ms is null then null
    else to_timestamp(p_from_ms::double precision / 1000.0)
  end;
  v_to timestamptz := case
    when p_to_ms is null then null
    else to_timestamp(p_to_ms::double precision / 1000.0)
  end;
  v_retention_cutoff timestamptz := case
    when v_plan = 'free' then now() - interval '7 days'
    else null
  end;
  v_free_cutoff timestamptz := now() - interval '7 days';
  v_q text := nullif(btrim(p_q), '');
  v_shared_ids uuid[];
  v_owned integer;
  v_shared integer;
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct te.endpoint_id), '{}'::uuid[])
  into v_shared_ids
  from public.team_endpoints te
  join public.team_members tm on tm.team_id = te.team_id
  join public.teams t on t.id = te.team_id
  where tm.user_id = p_user_id
    and t.subscription_status is not null;

  select count(*)::integer
  into v_owned
  from public.requests r
  join public.endpoints e on e.id = r.endpoint_id
  where r.user_id = p_user_id
    and (v_slug is null or e.slug = v_slug)
    and (v_method is null or v_method = 'ALL' or r.method = v_method)
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
  where r.endpoint_id = any(v_shared_ids)
    and r.user_id is distinct from p_user_id
    and (v_slug is null or e.slug = v_slug)
    and (v_method is null or v_method = 'ALL' or r.method = v_method)
    and (
      v_q is null
      or r.path ilike '%' || v_q || '%'
      or r.body ilike '%' || v_q || '%'
      or r.headers::text ilike '%' || v_q || '%'
    )
    and (v_from is null or r.received_at >= v_from)
    and (v_to is null or r.received_at <= v_to)
    and (r.team_id is not null or u.plan is distinct from 'free' or r.received_at >= v_free_cutoff);

  return coalesce(v_owned, 0) + coalesce(v_shared, 0);
end;
$$;

revoke all on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) from public;
revoke all on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) from anon;
revoke all on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) from authenticated;
grant execute on function public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text) to service_role;

revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) from public;
revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) from anon;
revoke all on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) from authenticated;
grant execute on function public.search_requests_count(uuid, text, text, text, text, bigint, bigint) to service_role;
