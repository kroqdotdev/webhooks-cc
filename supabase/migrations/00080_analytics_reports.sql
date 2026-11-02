-- ============================================================================
-- 00080: product analytics reports
-- ============================================================================
-- The web app's analytics reporter (apps/web/lib/analytics/reporter.ts) sends
-- PostHog two kinds of server-side report: the accounts created in each hour,
-- and a usage snapshot per account for each UTC day. Webhook traffic itself
-- never goes to PostHog, only these counts.
--
-- analytics_report_runs: one row per report and period, inserted by whichever
-- web process claims it first; a second insert fails on the primary key, so
-- several processes never send a period twice. A claim is never released: a
-- send that fails after its claim loses that period, which costs a gap in a
-- chart, never a duplicate.
--
-- analytics_daily_accounts(day): every account that captured something, took
-- an audited action, or was created on that day, with the day's counts from
-- endpoint_daily_stats and the account's current state (plan, what it has set
-- up). first_capture marks the account's first day with captured requests.
--
-- Both are service-role only. No deploy order: the reporter skips a missing
-- function or table and tries again later.
-- ============================================================================

begin;

create table if not exists public.analytics_report_runs (
  report       text not null,
  period_start timestamptz not null,
  claimed_at   timestamptz not null default now(),
  primary key (report, period_start),
  constraint analytics_report_runs_report check (report in ('signups', 'daily_usage'))
);

alter table public.analytics_report_runs enable row level security;
revoke all on table public.analytics_report_runs from anon, authenticated;

create or replace function public.analytics_daily_accounts(p_day date)
returns table (
  user_id uuid,
  email text,
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
    select p_day::timestamptz as day_start, (p_day + 1)::timestamptz as day_end
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
  active as (
    select t.user_id from traffic t
    union
    select a.user_id from actions a
    union
    select u.id from public.users u, day_bounds b
     where u.created_at >= b.day_start and u.created_at < b.day_end
  )
  select u.id,
         u.email,
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
    left join actions a on a.user_id = u.id;
$$;

revoke all on function public.analytics_daily_accounts(date) from public, anon, authenticated;
grant execute on function public.analytics_daily_accounts(date) to service_role;

commit;
