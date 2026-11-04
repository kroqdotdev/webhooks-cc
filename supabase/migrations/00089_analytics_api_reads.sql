-- ============================================================================
-- 00089: API reads per client in the daily analytics report
-- ============================================================================
-- Reads (listing requests, waiting for one, getting an endpoint) are not
-- audited, so the daily report only saw the SDKs, the CLI and the MCP servers
-- when they changed something. The web app now counts reads made with an API
-- key or agent token in memory, per account, UTC day and client
-- (apps/web/lib/analytics-reads.ts), and adds them here about once a minute
-- per process, one row per account, day and client in one statement. Nothing
-- is written per request.
--
-- analytics_api_reads: the counts. Kept 35 days by a nightly job; the report
-- reads at most the last three days.
--
-- analytics_add_api_reads(rows): adds a batch of counts. Rows for an account
-- deleted since they were counted are dropped.
--
-- analytics_daily_accounts(day): also lists accounts whose only activity that
-- day was reading, and returns api_reads (the day's total) and
-- api_reads_by_client (client name to count). Dropped and created again
-- because its result type changes; the reporter of the running release
-- ignores the new columns, so this applies before the deploy.
--
-- All service-role only.
-- ============================================================================

begin;

create table if not exists public.analytics_api_reads (
  user_id uuid not null references public.users(id) on delete cascade,
  day     date not null,
  client  text not null,
  reads   bigint not null default 0,
  primary key (user_id, day, client),
  constraint analytics_api_reads_client check (char_length(client) between 1 and 32),
  constraint analytics_api_reads_positive check (reads >= 0)
);

-- The report reads one day for every account.
create index if not exists analytics_api_reads_day on public.analytics_api_reads (day);

alter table public.analytics_api_reads enable row level security;
revoke all on table public.analytics_api_reads from anon, authenticated;

create or replace function public.analytics_add_api_reads(p_rows jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.analytics_api_reads as t (user_id, day, client, reads)
  select r.user_id, r.day, left(r.client, 32), sum(r.reads)
    from jsonb_to_recordset(p_rows) as r(user_id uuid, day date, client text, reads bigint)
   where r.reads > 0
     and r.client <> ''
     and exists (select 1 from public.users u where u.id = r.user_id)
   group by r.user_id, r.day, left(r.client, 32)
  on conflict (user_id, day, client) do update set reads = t.reads + excluded.reads;
$$;

revoke all on function public.analytics_add_api_reads(jsonb) from public, anon, authenticated;
grant execute on function public.analytics_add_api_reads(jsonb) to service_role;

drop function if exists public.analytics_daily_accounts(date);

create function public.analytics_daily_accounts(p_day date)
returns table (
  user_id uuid,
  plan text,
  billing_interval text,
  subscription_status text,
  home_site text,
  signed_up_at timestamptz,
  request_limit integer,
  requests_used integer,
  overage_active boolean,
  captured bigint,
  quota_rejected bigint,
  bytes bigint,
  endpoints_with_traffic bigint,
  first_capture boolean,
  audited_actions bigint,
  api_reads bigint,
  api_reads_by_client jsonb,
  endpoints_count bigint,
  email_endpoints_count bigint,
  layout_endpoints_count bigint,
  destinations_count bigint,
  verified_domains_count bigint,
  api_keys_count bigint,
  connected_agents_count bigint,
  teams_count bigint
)
language sql
stable
set search_path = ''
as $$
  with day_bounds as (
    -- endpoint_daily_stats.day is a UTC day, whatever the session's time zone.
    select p_day::timestamp at time zone 'UTC' as day_start,
           (p_day + 1)::timestamp at time zone 'UTC' as day_end
  ),
  traffic as (
    select s.user_id,
           sum(s.captured)::bigint as captured,
           sum(s.quota_rejected)::bigint as quota_rejected,
           sum(s.bytes)::bigint as bytes,
           count(*) filter (where s.captured > 0)::bigint as endpoints_with_traffic
      from public.endpoint_daily_stats s
     where s.day = p_day and s.user_id is not null
     group by s.user_id
  ),
  actions as (
    select a.actor_user_id as user_id, count(*)::bigint as audited_actions
      from public.audit_events a, day_bounds b
     where a.occurred_at >= b.day_start and a.occurred_at < b.day_end
       and a.actor_user_id is not null
     group by a.actor_user_id
  ),
  reads as (
    select r.user_id,
           sum(r.reads)::bigint as api_reads,
           jsonb_object_agg(r.client, r.reads) as api_reads_by_client
      from public.analytics_api_reads r
     where r.day = p_day
     group by r.user_id
  ),
  active as (
    select t.user_id from traffic t
    union
    select a.user_id from actions a
    union
    select r.user_id from reads r
    union
    select u.id from public.users u, day_bounds b
     where u.created_at >= b.day_start and u.created_at < b.day_end
  )
  select u.id,
         u.plan,
         u.billing_interval,
         u.subscription_status,
         u.home_site,
         u.created_at,
         u.request_limit,
         u.requests_used,
         u.overage_active,
         coalesce(t.captured, 0),
         coalesce(t.quota_rejected, 0),
         coalesce(t.bytes, 0),
         coalesce(t.endpoints_with_traffic, 0),
         coalesce(t.captured, 0) > 0 and not exists (
           select 1 from public.endpoint_daily_stats p
            where p.user_id = u.id and p.day < p_day and p.captured > 0
         ),
         coalesce(a.audited_actions, 0),
         coalesce(r.api_reads, 0),
         coalesce(r.api_reads_by_client, '{}'::jsonb),
         (select count(*) from public.endpoints e where e.user_id = u.id),
         (select count(*) from public.endpoints e
           where e.user_id = u.id and e.last_email_at is not null),
         (select count(*) from public.endpoints e
           where e.user_id = u.id and e.layouts <> '[]'::jsonb),
         (select count(*) from public.endpoint_destinations d
            join public.endpoints e on e.id = d.endpoint_id
           where e.user_id = u.id),
         (select count(*) from public.inbound_domains i
           where i.user_id = u.id and i.status = 'verified'),
         (select count(*) from public.api_keys k
           where k.user_id = u.id and not k.is_agent_issued and not k.is_device_auth),
         (select count(*) from public.agent_registrations r
           where r.user_id = u.id and r.claimed_at is not null and r.revoked_at is null),
         (select count(*) from public.team_members m where m.user_id = u.id)
    from active
    join public.users u on u.id = active.user_id
    left join traffic t on t.user_id = u.id
    left join actions a on a.user_id = u.id
    left join reads r on r.user_id = u.id
   order by u.id;
$$;

revoke all on function public.analytics_daily_accounts(date) from public, anon, authenticated;
grant execute on function public.analytics_daily_accounts(date) to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'analytics-api-reads-cleanup';
select cron.schedule(
  'analytics-api-reads-cleanup',
  '41 3 * * *',
  $$delete from public.analytics_api_reads where day < current_date - 35$$
);

commit;

notify pgrst, 'reload schema';
