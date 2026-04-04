-- ============================================================================
-- Migration 00021: Make search predicates compatible with trigram indexes
--
-- The body search predicate used coalesce(r.body, '') which prevented
-- PostgreSQL from using the GIN trigram index on the bare body column.
-- Since NULL ILIKE '%..%' already returns NULL (falsy), the coalesce
-- was unnecessary. Removing it lets the planner use requests_body_trgm.
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
  v_q text := nullif(btrim(p_q), '');
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  return query execute format(
    'select
       r.id::text,
       e.slug,
       r.method,
       r.path,
       r.headers,
       nullif(r.body, ''''),
       r.query_params,
       nullif(r.content_type, ''''),
       r.ip,
       r.size,
       floor(extract(epoch from r.received_at) * 1000)::bigint
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
       and ($7 is null or r.received_at >= $7)
     order by r.received_at %s
     limit %s offset %s',
    v_order,
    v_limit,
    v_offset
  )
  using p_user_id, nullif(btrim(p_slug), ''), nullif(btrim(p_method), ''), v_q, v_from, v_to, v_retention_cutoff;
end;
$$;

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
  v_q text := nullif(btrim(p_q), '');
  v_count integer;
begin
  if v_plan not in ('free', 'pro') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  select count(*)::integer
  into v_count
  from public.requests r
  join public.endpoints e on e.id = r.endpoint_id
  where r.user_id = p_user_id
    and (nullif(btrim(p_slug), '') is null or e.slug = nullif(btrim(p_slug), ''))
    and (nullif(btrim(p_method), '') is null or nullif(btrim(p_method), '') = 'ALL' or r.method = nullif(btrim(p_method), ''))
    and (
      v_q is null
      or r.path ilike '%' || v_q || '%'
      or r.body ilike '%' || v_q || '%'
      or r.headers::text ilike '%' || v_q || '%'
    )
    and (v_from is null or r.received_at >= v_from)
    and (v_to is null or r.received_at <= v_to)
    and (v_retention_cutoff is null or r.received_at >= v_retention_cutoff);

  return coalesce(v_count, 0);
end;
$$;
