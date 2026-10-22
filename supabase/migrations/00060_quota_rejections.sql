-- ============================================================================
-- 00060: quota rejections per endpoint for the current period
-- ============================================================================
-- The quota-exhausted email and the dashboard banner told a capped user that
-- their webhooks were being rejected, but not how many or on which endpoints.
-- endpoint_daily_stats (migration 00041) already counts a quota_rejected per
-- endpoint per UTC day; get_quota_rejections() reads it back for one user.
--
-- Scope of the count:
--   * Days from the UTC date of users.period_start onward. The table is kept
--     per day, so the first day can include a few rejections from before the
--     period began; a user with no period_start is read from today only.
--   * Endpoints the user owns that are not billed to a subscribed team.
--     Rejections on a team-billed endpoint came from the team's quota, which
--     the owner's email and banner say is unaffected.
--   * Endpoints that still exist: the slug is read from public.endpoints.
--
-- One row per endpoint (most rejected first, ties by slug), limited to
-- p_limit. total_rejected and endpoint_count are computed before the limit,
-- so they describe every affected endpoint, not just the rows returned.
--
-- Service role only, like the rest of the quota functions: the web app calls
-- it with the admin client.
-- ============================================================================

create or replace function public.get_quota_rejections(
  p_user_id uuid,
  p_limit   integer default 5
)
returns table (
  slug            text,
  quota_rejected  bigint,
  total_rejected  bigint,
  endpoint_count  bigint
)
language sql
stable
set search_path = ''
as $$
  with since as (
    select coalesce(
             (u.period_start at time zone 'utc')::date,
             (now() at time zone 'utc')::date
           ) as day
      from public.users u
     where u.id = p_user_id
  ),
  per_endpoint as (
    select e.slug, sum(s.quota_rejected)::bigint as rejected
      from public.endpoints e
      join public.endpoint_daily_stats s on s.endpoint_id = e.id
      cross join since
     where e.user_id = p_user_id
       and s.day >= since.day
       and s.quota_rejected > 0
       and not public.is_team_billed_endpoint(e.id)
     group by e.id, e.slug
  )
  select p.slug,
         p.rejected,
         (sum(p.rejected) over ())::bigint,
         (count(*) over ())::bigint
    from per_endpoint p
   order by p.rejected desc, p.slug
   limit greatest(p_limit, 0);
$$;

revoke all on function public.get_quota_rejections(uuid, integer) from public;
revoke all on function public.get_quota_rejections(uuid, integer) from anon;
revoke all on function public.get_quota_rejections(uuid, integer) from authenticated;
grant execute on function public.get_quota_rejections(uuid, integer) to service_role;
