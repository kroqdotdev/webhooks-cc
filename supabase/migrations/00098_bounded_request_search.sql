-- 00098: request search that stays fast however long an endpoint keeps
-- its requests.
--
-- search_requests() and search_requests_count() (00076) match a substring
-- with ILIKE over every retained row in scope, with no text index (00044
-- dropped the trigram indexes because they cost captures about 8x the WAL).
-- A term that matches rarely or never reads the whole range: about 60 us a
-- row in production, so 6 s for 100k rows and most of a minute for an
-- endpoint on a 90-day plan, with nothing to stop it.
--
-- search_requests_page() bounds every search instead of indexing it:
--
--   * It walks the range newest first (or oldest first) in slices of rows,
--     each slice cut on the time index so it costs the same whatever the
--     density, and stops at the page size, at the end of the range, or when
--     its time budget (p_budget_ms) is spent. It answers where it stopped
--     (searched_until), whether it covered everything (complete) and a
--     cursor to continue from, so callers page backwards through time.
--     Slices grow or shrink to the time the last one took, so the budget
--     holds for both small JSON bodies and 1 MiB emails.
--   * Inside a slice the rows are read in time order with a LIMIT, so a
--     common term stops after the page fills (milliseconds), and the plan is
--     pinned to that walk (bitmap scans off, no parallel workers), because
--     the planner guesses ~50 matches for any '%x%' and otherwise sorts the
--     whole range first.
--   * A term made only of printable ASCII matches under COLLATE "C": ILIKE
--     lower()s both sides, and lower() under the database's ICU-free
--     en_US.UTF-8 locale was ~63% of the cost a row. For an ASCII term the
--     result is the same (only ASCII letters can match its letters); other
--     terms keep the locale's case folding.
--   * %, _ and \ in the term are literal (they were LIKE wildcards).
--   * Emails also match their decoded subject, text and addresses, not only
--     the raw MIME (which is base64 or quoted-printable for many messages).
--   * A term that is a request id finds that request first, by primary key.
--   * With p_count it counts instead, under the same budget, and says
--     whether the count is exact.
--   * A slug-scoped search reads the endpoint once (the old function read a
--     team-shared endpoint twice), and a slug the caller can neither own nor
--     see through a team answers at once instead of walking someone else's
--     rows.
--
-- New bodies are compressed with lz4, which decompresses about twice as
-- fast as pglz; rows already stored keep pglz until rewritten.
--
-- The old functions stay until the web release that calls them is gone
-- (a later migration drops them). Re-runnable.

alter table public.requests alter column body set compression lz4;

create or replace function public.search_requests_page(
  p_user_id uuid,
  p_plan text default null,
  p_slug text default null,
  p_method text default null,
  p_q text default null,
  p_from_ms bigint default null,
  p_to_ms bigint default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_order text default 'desc',
  p_kind text default null,
  p_cursor text default null,
  p_budget_ms integer default 2000,
  p_count boolean default false
)
returns json
language plpgsql
security definer
set search_path to ''
set max_parallel_workers_per_gather to 0
set enable_bitmapscan to off
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
as $$
declare
  c_min_id constant uuid := '00000000-0000-0000-0000-000000000000';
  c_max_id constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  -- A slice ends at whichever comes first, a number of rows or a number of
  -- stored bytes (requests.size), so a run of 1 MiB emails is as bounded as
  -- one of small JSON bodies. Both start small and then follow the time the
  -- last slice took, growing at most 4x a step.
  c_first_slice constant integer := 500;
  c_min_slice constant integer := 50;
  c_max_slice constant integer := 50000;
  c_first_bytes constant bigint := 4194304;
  c_min_bytes constant bigint := 262144;
  c_max_bytes constant bigint := 268435456;
  c_max_growth constant double precision := 4.0;

  v_plan text := coalesce(p_plan, 'pro');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_desc boolean := lower(coalesce(p_order, 'desc')) <> 'asc';
  v_budget_ms double precision := least(greatest(coalesce(p_budget_ms, 2000), 1), 10000);
  v_slug text := nullif(btrim(p_slug), '');
  v_method text := nullif(nullif(btrim(p_method), ''), 'ALL');
  v_kind text := nullif(btrim(p_kind), '');
  v_q text := nullif(btrim(p_q), '');
  v_from timestamptz := case when p_from_ms is null then null
                             else to_timestamp(p_from_ms::double precision / 1000.0) end;
  v_to timestamptz := case when p_to_ms is null then null
                           else to_timestamp(p_to_ms::double precision / 1000.0) end;
  -- The plan's retention, or the account's grace after a downgrade when that
  -- is longer (as in 00076): personal rows older than this are hidden.
  v_owned_cutoff timestamptz := now() - make_interval(days => greatest(
    coalesce((select pe.retention_days from public.plan_entitlements pe
               where pe.key = coalesce(p_plan, 'pro')), 31),
    coalesce(public.account_retention_days(p_user_id, null), 0)));

  v_pattern text;
  v_collate text := '';
  v_q_id uuid;

  -- Endpoints shared with the caller through a subscribed team that the
  -- caller does not own (rows of the caller's own endpoints are "owned").
  v_shared uuid[];
  v_endpoint_id uuid;
  v_endpoint_owner uuid;
  v_endpoint_days integer;
  v_owner_days integer;
  v_shared_mode boolean := false;
  v_row_cutoff timestamptz;

  -- The range in scope, oldest and newest, after from/to and the endpoint's
  -- own retention.
  v_lo timestamptz;
  v_hi timestamptz;
  -- Walk position: rows strictly beyond (v_pos_ts, v_pos_id) in walk order
  -- are still to be read.
  v_pos_ts timestamptz;
  v_pos_id uuid;
  v_parts text[];

  v_op text;
  v_dir text;
  v_where text;
  v_where_shared text;
  v_filters text := '';
  v_match text := '';
  v_slice_sql text;
  v_bound_sql text;
  v_cmp_lo text;
  v_cmp_hi text;
  v_hit_sql text;

  v_n integer := c_first_slice;
  v_bytes bigint := c_first_bytes;
  v_factor double precision;
  v_bound_stream text;
  v_edge timestamptz;
  v_b timestamptz;
  v_sid uuid;
  v_final boolean;
  v_started timestamptz := clock_timestamp();
  v_slice_started timestamptz;
  v_elapsed double precision;
  v_slice_ms double precision;
  v_need integer;
  v_got_ids uuid[];
  v_got_ts timestamptz[];
  v_got integer;
  v_got_count bigint;
  v_ids uuid[] := '{}';
  v_count bigint := 0;
  v_hit_id uuid;
  v_hit_ts timestamptz;
  v_complete boolean := false;
  v_stop_ts timestamptz;
  v_stop_id uuid;
  v_slices integer := 0;
  v_part_kind text;
  v_page uuid[];
  v_rows json;
  v_until bigint;
  v_cursor text;
begin
  if not exists (select 1 from public.plan_entitlements pe where pe.key = v_plan) then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  if p_user_id is null then
    -- Every visibility rule below compares against the caller.
    if p_count then
      return json_build_object('count', 0, 'exact', true, 'searched_until', null,
                               'cursor', null, 'slices', 0);
    end if;
    return json_build_object('requests', '[]'::json, 'complete', true,
                             'searched_until', null, 'cursor', null, 'slices', 0);
  end if;

  v_op := case when v_desc then '<' else '>' end;
  v_dir := case when v_desc then 'desc' else 'asc' end;

  if v_q is not null then
    v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q !~ '[^\x20-\x7e]' then
      v_collate := ' collate "C"';
    end if;
    if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_q_id := v_q::uuid;
    end if;
    v_match := format(
      ' and (r.path%1$s ilike $5 or r.headers::text%1$s ilike $5 or r.body%1$s ilike $5'
      || ' or (r.kind = ''email'' and r.email is not null and ('
      || '(r.email->>''subject'')%1$s ilike $5 or (r.email->>''text'')%1$s ilike $5'
      || ' or (r.email->''from'')::text%1$s ilike $5 or (r.email->''to'')::text%1$s ilike $5'
      || ' or (r.email->''cc'')::text%1$s ilike $5)))',
      v_collate);
  end if;

  if v_method is not null then
    v_filters := v_filters || ' and r.method = $10';
  end if;
  if v_kind is not null then
    v_filters := v_filters || ' and r.kind = $11';
  end if;
  if v_q_id is not null then
    -- Found by primary key below; the walk must not return it twice.
    v_filters := v_filters || ' and r.id <> $13';
  end if;

  select coalesce(array_agg(distinct te.endpoint_id), '{}'::uuid[])
    into v_shared
    from public.team_endpoints te
    join public.team_members tm on tm.team_id = te.team_id
    join public.teams t on t.id = te.team_id
    join public.endpoints e on e.id = te.endpoint_id
   where tm.user_id = p_user_id
     and t.subscription_status is not null
     and e.user_id is distinct from p_user_id;

  v_lo := v_from;
  v_hi := v_to;

  if v_slug is not null then
    select e.id, e.user_id, e.retention_days
      into v_endpoint_id, v_endpoint_owner, v_endpoint_days
      from public.endpoints e
     where e.slug = v_slug;

    if v_endpoint_id is not null and v_endpoint_owner is distinct from p_user_id then
      if v_endpoint_id = any(v_shared) then
        v_shared_mode := true;
        select pe.retention_days into v_owner_days
          from public.users u
          join public.plan_entitlements pe on pe.key = u.plan
         where u.id = v_endpoint_owner;
      else
        -- Neither owned nor shared: nothing the caller may see. Every row of
        -- an endpoint carries its owner's user_id, so this is what the row
        -- filters would find, without reading the rows.
        v_endpoint_id := null;
      end if;
    end if;

    if v_endpoint_id is null then
      if p_count then
        return json_build_object('count', 0, 'exact', true, 'searched_until', null,
                                 'cursor', null, 'slices', 0);
      end if;
      return json_build_object('requests', '[]'::json, 'complete', true,
                               'searched_until', null, 'cursor', null, 'slices', 0);
    end if;

    if v_endpoint_days is not null then
      v_lo := greatest(v_lo, now() - make_interval(days => v_endpoint_days));
    end if;
    v_row_cutoff := case
      when v_shared_mode then
        case when v_owner_days is null then null
             else now() - make_interval(days => v_owner_days) end
      else v_owned_cutoff end;

    -- One endpoint, read through requests_endpoint_time. Team-billed rows
    -- keep the team's retention, so only personal rows are cut here.
    v_where := format(
      'r.endpoint_id = $1 and r.user_id %s $2', case when v_shared_mode then 'is distinct from' else '=' end)
      || case when v_row_cutoff is null then ''
              else ' and (r.team_id is not null or r.received_at >= $3)' end;
    v_bound_stream := 'r.endpoint_id = $1';
  else
    v_row_cutoff := v_owned_cutoff;
    -- Every endpoint the caller owns, through requests_user_time, and every
    -- endpoint shared with them, each through requests_endpoint_time.
    v_where := 'r.user_id = $2 and (r.team_id is not null or r.received_at >= $3)'
      || ' and (e.retention_days is null'
      || ' or r.received_at >= now() - make_interval(days => e.retention_days))';
    v_where_shared := 'r.endpoint_id = any($4) and r.user_id is distinct from $2'
      || ' and (r.team_id is not null or pe.retention_days is null'
      || ' or r.received_at >= now() - make_interval(days => pe.retention_days))'
      || ' and (e.retention_days is null'
      || ' or r.received_at >= now() - make_interval(days => e.retention_days))';
    v_bound_stream := 'r.user_id = $2';
  end if;

  -- The far edge of a slice in one stream: the time of the row where the
  -- slice reaches $14 rows or $15 stored bytes, null when the stream has
  -- less than that left. Filled in per slice with the comparison operators
  -- (%1$s, %2$s, which depend on the position), the order and the stream.
  v_bound_sql := 'with w as (select b.received_at,'
    || ' row_number() over (order by b.received_at %3$s) as rn,'
    || ' sum(b.size::bigint) over (order by b.received_at %3$s rows unbounded preceding) as bytes'
    || ' from (select r.received_at, r.size from public.requests r where %4$s'
    || ' and r.received_at %1$s $6 and r.received_at %2$s $7'
    || ' order by r.received_at %3$s limit $14) b)'
    || ' select coalesce((select w.received_at from w where w.bytes >= $15 order by w.rn limit 1),'
    || ' (select w.received_at from w where w.rn = $14))';
  if v_q is null then
    -- Without a term a slice never reads bodies, so only rows bound it.
    v_bytes := c_max_bytes * 1024;
  end if;

  -- An endpoint's count with no term and no method (the dashboard's total)
  -- is exact and cheap: every row of an endpoint carries its owner's
  -- user_id, so inside the range only personal rows past the plan's
  -- retention need their heap row, and the rest is an index-only count of
  -- requests_endpoint_time (or requests_endpoint_email_time for email).
  if p_count and v_slug is not null and v_q is null and v_method is null
     and (p_cursor is null or btrim(p_cursor) = '') then
    -- HTTP is every row less the email ones, each an index-only count.
    foreach v_part_kind in array (case when v_kind = 'http' then array['all', 'email']
                                       else array[coalesce(v_kind, 'all')] end) loop
      execute 'select count(*) from public.requests r where r.endpoint_id = $1'
        || ' and r.received_at >= $2 and r.received_at <= $3'
        || case when v_part_kind = 'email' then ' and r.kind = ''email''' else '' end
        into v_got_count
        using v_endpoint_id,
              greatest(coalesce(v_lo, '-infinity'::timestamptz), coalesce(v_row_cutoff, '-infinity'::timestamptz)),
              coalesce(v_hi, 'infinity'::timestamptz);
      v_count := v_count + (case when v_part_kind = 'email' and v_kind = 'http'
                                 then -v_got_count else v_got_count end);
      if v_row_cutoff is not null and v_row_cutoff > coalesce(v_lo, '-infinity'::timestamptz) then
        execute 'select count(*) from public.requests r where r.endpoint_id = $1'
          || ' and r.received_at >= $2 and r.received_at < $3 and r.received_at <= $4'
          || ' and r.team_id is not null'
          || case when v_part_kind = 'email' then ' and r.kind = ''email''' else '' end
          into v_got_count
          using v_endpoint_id, coalesce(v_lo, '-infinity'::timestamptz), v_row_cutoff,
                coalesce(v_hi, 'infinity'::timestamptz);
        v_count := v_count + (case when v_part_kind = 'email' and v_kind = 'http'
                                   then -v_got_count else v_got_count end);
      end if;
    end loop;
    return json_build_object('count', v_count, 'exact', true, 'searched_until',
                             case when v_lo is null then null
                                  else floor(extract(epoch from v_lo) * 1000)::bigint end,
                             'cursor', null, 'slices', 0);
  end if;

  -- Where the walk starts: the cursor, else the near end of the range.
  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_parts := string_to_array(p_cursor, '|');
    if array_length(v_parts, 1) not in (3, 4)
       or v_parts[1] <> (case when v_desc then 'd' else 'a' end) then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    begin
      v_pos_ts := v_parts[2]::timestamptz;
      v_pos_id := v_parts[3]::uuid;
      -- The part of the caller's offset earlier pages had not skipped yet:
      -- the cursor carries it, so an offset is never applied twice.
      v_offset := least(greatest(coalesce(v_parts[4]::integer, 0), 0), 10000);
    exception when others then
      raise exception 'invalid cursor' using errcode = '22023';
    end;
    -- A cursor never reaches past the range (from/to and the endpoint's own
    -- retention), whatever it says.
    if v_desc and v_hi is not null and v_pos_ts > v_hi then
      v_pos_ts := v_hi;
      v_pos_id := c_max_id;
    elsif not v_desc and v_lo is not null and v_pos_ts < v_lo then
      v_pos_ts := v_lo;
      v_pos_id := c_min_id;
    end if;
  elsif v_desc then
    v_pos_ts := coalesce(v_hi, 'infinity'::timestamptz);
    v_pos_id := c_max_id;
  else
    v_pos_ts := coalesce(v_lo, '-infinity'::timestamptz);
    v_pos_id := c_min_id;
  end if;

  -- The request a term names by id, first, when it is in scope.
  if v_q_id is not null and (p_cursor is null or btrim(p_cursor) = '') then
    if v_slug is not null then
      v_hit_sql := 'select r.id, r.received_at from public.requests r where r.id = $13 and '
        || v_where || replace(v_filters, ' and r.id <> $13', '')
        || ' and r.received_at >= coalesce($6, ''-infinity'') and r.received_at <= coalesce($7, ''infinity'')';
    else
      v_hit_sql := 'select r.id, r.received_at from public.requests r'
        || ' join public.endpoints e on e.id = r.endpoint_id'
        || ' left join public.users u on u.id = e.user_id'
        || ' left join public.plan_entitlements pe on pe.key = u.plan'
        || ' where r.id = $13 and ((' || v_where || ') or (' || v_where_shared || '))'
        || replace(v_filters, ' and r.id <> $13', '')
        || ' and r.received_at >= coalesce($6, ''-infinity'') and r.received_at <= coalesce($7, ''infinity'')';
    end if;
    execute v_hit_sql into v_hit_id, v_hit_ts
      using v_endpoint_id, p_user_id, v_row_cutoff, v_shared, v_pattern,
            v_lo, v_hi, null::timestamptz, null::uuid, v_method, v_kind, null::integer, v_q_id, null::integer;
    if v_hit_id is not null then
      v_ids := array[v_hit_id];
      v_count := 1;
    end if;
  end if;

  -- The slice statement: rows between v_edge and the position, in walk
  -- order, filtered and matched.
  if v_slug is not null then
    v_slice_sql := 'from public.requests r where ' || v_where
      || ' and r.received_at >= $6 and r.received_at <= $7'
      || format(' and (r.received_at %1$s $8 or r.id %1$s $9)', v_op)
      || v_filters || v_match;
    if p_count then
      v_slice_sql := 'select count(*) ' || v_slice_sql;
    else
      v_slice_sql := 'select array_agg(x.id order by x.received_at ' || v_dir || ', x.id ' || v_dir || '),'
        || ' array_agg(x.received_at order by x.received_at ' || v_dir || ', x.id ' || v_dir || ')'
        || ' from (select r.id, r.received_at ' || v_slice_sql
        || format(' order by r.received_at %1$s, r.id %1$s limit $12) x', v_dir);
    end if;
  else
    v_slice_sql := 'from public.requests r join public.endpoints e on e.id = r.endpoint_id where '
      || v_where
      || ' and r.received_at >= $6 and r.received_at <= $7'
      || format(' and (r.received_at %1$s $8 or r.id %1$s $9)', v_op)
      || v_filters || v_match;
    if cardinality(v_shared) > 0 then
      v_slice_sql := v_slice_sql || '#SHARED#';
    end if;
    if p_count then
      v_slice_sql := 'select count(*) ' || v_slice_sql;
      if cardinality(v_shared) > 0 then
        v_slice_sql := replace(v_slice_sql, '#SHARED#', '')
          || ' union all select count(*) from public.requests r'
          || ' join public.endpoints e on e.id = r.endpoint_id'
          || ' left join public.users u on u.id = e.user_id'
          || ' left join public.plan_entitlements pe on pe.key = u.plan where '
          || v_where_shared
          || ' and r.received_at >= $6 and r.received_at <= $7'
          || format(' and (r.received_at %1$s $8 or r.id %1$s $9)', v_op)
          || v_filters || v_match;
        v_slice_sql := 'select sum(c)::bigint from (' || v_slice_sql || ') s(c)';
      end if;
    else
      v_slice_sql := '(select r.id, r.received_at ' || replace(v_slice_sql, '#SHARED#', '')
        || format(' order by r.received_at %1$s, r.id %1$s limit $12)', v_dir);
      if cardinality(v_shared) > 0 then
        v_slice_sql := v_slice_sql || ' union all (select r.id, r.received_at from public.requests r'
          || ' join public.endpoints e on e.id = r.endpoint_id'
          || ' left join public.users u on u.id = e.user_id'
          || ' left join public.plan_entitlements pe on pe.key = u.plan where '
          || v_where_shared
          || ' and r.received_at >= $6 and r.received_at <= $7'
          || format(' and (r.received_at %1$s $8 or r.id %1$s $9)', v_op)
          || v_filters || v_match
          || format(' order by r.received_at %1$s, r.id %1$s limit $12)', v_dir);
      end if;
      v_slice_sql := 'select array_agg(x.id order by x.received_at ' || v_dir || ', x.id ' || v_dir || '),'
        || ' array_agg(x.received_at order by x.received_at ' || v_dir || ', x.id ' || v_dir || ')'
        || ' from (select y.id, y.received_at from (' || v_slice_sql || ') y'
        || format(' order by y.received_at %1$s, y.id %1$s limit $12) x', v_dir);
    end if;
  end if;

  loop
    v_slice_started := clock_timestamp();
    v_slices := v_slices + 1;

    -- The far edge of this slice: the time of the v_n-th row past the
    -- position in each stream (the nearest of those, so no stream gives more
    -- than v_n rows), or the end of the range when every stream has fewer.
    -- Rows at exactly that time all fall in this slice.
    v_edge := null;
    v_final := true;
    -- The rows at the position's own time are still to be read unless the
    -- position is a slice edge (the sentinel id), which read all of them.
    if v_desc then
      v_cmp_lo := '>=';
      v_cmp_hi := case when v_pos_id = c_min_id then '<' else '<=' end;
    else
      v_cmp_lo := case when v_pos_id = c_max_id then '>' else '>=' end;
      v_cmp_hi := '<=';
    end if;
    execute format(v_bound_sql, v_cmp_lo, v_cmp_hi, v_dir, v_bound_stream) into v_b
      using v_endpoint_id, p_user_id, null::timestamptz, null::uuid[], null::text,
            case when v_desc then coalesce(v_lo, '-infinity'::timestamptz) else v_pos_ts end,
            case when v_desc then v_pos_ts else coalesce(v_hi, 'infinity'::timestamptz) end,
            null::timestamptz, null::uuid, null::text, null::text, null::integer, null::uuid,
            v_n, v_bytes;
    if v_b is not null then
      v_edge := v_b;
      v_final := false;
    end if;
    if v_slug is null then
      foreach v_sid in array v_shared loop
        execute format(v_bound_sql, v_cmp_lo, v_cmp_hi, v_dir, 'r.endpoint_id = $1') into v_b
          using v_sid, p_user_id, null::timestamptz, null::uuid[], null::text,
                case when v_desc then coalesce(v_lo, '-infinity'::timestamptz) else v_pos_ts end,
                case when v_desc then v_pos_ts else coalesce(v_hi, 'infinity'::timestamptz) end,
                null::timestamptz, null::uuid, null::text, null::text, null::integer, null::uuid,
                v_n, v_bytes;
        if v_b is not null then
          v_final := false;
          v_edge := case when v_edge is null then v_b
                         when v_desc then greatest(v_edge, v_b)
                         else least(v_edge, v_b) end;
        end if;
      end loop;
    end if;
    if v_edge is null then
      v_edge := case when v_desc then coalesce(v_lo, '-infinity'::timestamptz)
                     else coalesce(v_hi, 'infinity'::timestamptz) end;
    end if;

    if p_count then
      execute v_slice_sql into v_got_count
        using v_endpoint_id, p_user_id, v_row_cutoff, v_shared, v_pattern,
              case when v_desc then v_edge else v_pos_ts end,
              case when v_desc then v_pos_ts else v_edge end,
              v_pos_ts, v_pos_id, v_method, v_kind, null::integer, v_q_id, null::integer;
      v_count := v_count + coalesce(v_got_count, 0);
    else
      -- One more than still needed, to know whether more matches follow.
      v_need := v_limit + v_offset - cardinality(v_ids);
      execute v_slice_sql into v_got_ids, v_got_ts
        using v_endpoint_id, p_user_id, v_row_cutoff, v_shared, v_pattern,
              case when v_desc then v_edge else v_pos_ts end,
              case when v_desc then v_pos_ts else v_edge end,
              v_pos_ts, v_pos_id, v_method, v_kind, v_need + 1, v_q_id, null::integer;
      v_got := coalesce(cardinality(v_got_ids), 0);
      if v_got > v_need then
        -- The page is full and more matches follow: continue after the last
        -- one returned (or from here, when the request found by id alone
        -- filled it).
        if v_need > 0 then
          v_ids := v_ids || v_got_ids[1:v_need];
          v_stop_ts := v_got_ts[v_need];
          v_stop_id := v_got_ids[v_need];
        else
          v_stop_ts := v_pos_ts;
          v_stop_id := v_pos_id;
        end if;
        exit;
      end if;
      if v_got > 0 then
        v_ids := v_ids || v_got_ids;
      end if;
      if v_got = v_need and not v_final then
        -- Exactly full: the rest of this slice did not match, so continue
        -- after the slice.
        v_stop_ts := v_edge;
        v_stop_id := case when v_desc then c_min_id else c_max_id end;
        exit;
      end if;
    end if;

    if v_final then
      v_complete := true;
      exit;
    end if;

    -- Every row at or past the edge has been read.
    v_pos_ts := v_edge;
    v_pos_id := case when v_desc then c_min_id else c_max_id end;

    v_elapsed := extract(epoch from clock_timestamp() - v_started) * 1000.0;
    if v_elapsed >= v_budget_ms then
      v_stop_ts := v_pos_ts;
      v_stop_id := v_pos_id;
      exit;
    end if;

    -- Size the next slice to take an eighth of the budget, or what is left
    -- of it, at the rate the last one ran, growing at most 4x.
    v_slice_ms := greatest(extract(epoch from clock_timestamp() - v_slice_started) * 1000.0, 0.05);
    v_factor := least(least(v_budget_ms / 8.0, v_budget_ms - v_elapsed) / v_slice_ms, c_max_growth);
    v_n := least(greatest(floor(v_n * v_factor)::integer, c_min_slice), c_max_slice);
    if v_q is not null then
      v_bytes := least(greatest(floor(v_bytes * v_factor)::bigint, c_min_bytes), c_max_bytes);
    end if;
  end loop;

  if v_complete then
    v_until := case
      when v_desc and v_lo is not null then floor(extract(epoch from v_lo) * 1000)::bigint
      when not v_desc and v_hi is not null then floor(extract(epoch from v_hi) * 1000)::bigint
      else null end;
  else
    v_until := case when isfinite(v_stop_ts)
                    then floor(extract(epoch from v_stop_ts) * 1000)::bigint end;
    -- ISO text in UTC (set on the function), so it reads back exactly.
    v_cursor := case when v_desc then 'd' else 'a' end
      || '|' || v_stop_ts::text || '|' || v_stop_id::text
      || case when not p_count and cardinality(v_ids) < v_offset
              then '|' || (v_offset - cardinality(v_ids))::text else '' end;
  end if;

  if p_count then
    return json_build_object('count', v_count, 'exact', v_complete, 'searched_until', v_until,
                             'cursor', v_cursor, 'slices', v_slices);
  end if;

  v_page := v_ids[v_offset + 1 : v_offset + v_limit];
  select coalesce(json_agg(json_build_object(
           'id', r.id::text,
           'slug', e.slug,
           'method', r.method,
           'path', r.path,
           'headers', r.headers,
           'body', nullif(r.body, ''),
           'query_params', r.query_params,
           'content_type', nullif(r.content_type, ''),
           'ip', r.ip,
           'size', r.size,
           'received_at', floor(extract(epoch from r.received_at) * 1000)::bigint,
           'kind', r.kind,
           'email', r.email,
           'body_raw', r.body_raw) order by u.ord), '[]'::json)
    into v_rows
    from unnest(v_page) with ordinality u(id, ord)
    join public.requests r on r.id = u.id
    join public.endpoints e on e.id = r.endpoint_id;

  return json_build_object('requests', v_rows, 'complete', v_complete, 'searched_until', v_until,
                           'cursor', v_cursor, 'slices', v_slices);
end;
$$;

revoke all on function public.search_requests_page(uuid, text, text, text, text, bigint, bigint, integer, integer, text, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.search_requests_page(uuid, text, text, text, text, bigint, bigint, integer, integer, text, text, text, integer, boolean) to service_role;
