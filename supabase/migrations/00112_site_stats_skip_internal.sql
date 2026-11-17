-- ============================================================================
-- Migration 00112: Site totals leave internal accounts out
--
-- Context: the landing page shows site_stats (webhooks received, endpoints,
-- users), and refresh_site_stats() (00038) counted every account. Internal
-- accounts (users.internal, 00087: tests, and from now on the status page's
-- canary, which captures about 600 requests a day and deletes each one)
-- would make the public total grow with traffic no customer sent.
--
-- Fix:
--   - refresh_site_stats() sums request_count and counts endpoints and users
--     only for accounts that are not internal. Guest endpoints (no user) are
--     counted as before.
--   - accumulate_deleted_endpoint_webhooks() moves only the counts of deleted
--     endpoints whose owner is not internal into deleted_webhooks. In an
--     account-deletion cascade the users row is already gone when the
--     statement trigger runs, so a deleted internal account's endpoints are
--     counted then: rare, and only ever too high, never lost.
--
-- Marking an account internal takes its live counts out of the total at the
-- next refresh (4x a day). Same signatures and grants as 00038; the whole
-- file runs in one transaction so the two functions change together.
-- ============================================================================

begin;

create or replace function public.accumulate_deleted_endpoint_webhooks()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_count bigint;
begin
  select coalesce(sum(d.request_count), 0)
    into v_count
    from deleted_endpoints d
   where not exists (
     select 1 from public.users u
      where u.id = d.user_id
        and u.internal
   );

  -- Skip the site_stats row lock when nothing was received on the deleted
  -- endpoints (sandbox rollbacks, unused endpoints, internal accounts).
  if v_count > 0 then
    update public.site_stats
       set deleted_webhooks = deleted_webhooks + v_count
     where id = 1;
  end if;

  return null;
end;
$$;

revoke all on function public.accumulate_deleted_endpoint_webhooks()
  from public, anon, authenticated;

create or replace function public.refresh_site_stats()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_live_webhooks bigint;
  v_deleted       bigint;
  v_endpoints     bigint;
  v_users         bigint;
begin
  -- Read under the site_stats row lock first, as in 00038, so an endpoint is
  -- never counted both live and deleted.
  select deleted_webhooks into v_deleted
    from public.site_stats
   where id = 1
     for update;

  select coalesce(sum(e.request_count), 0), count(*)
    into v_live_webhooks, v_endpoints
    from public.endpoints e
   where not exists (
     select 1 from public.users u
      where u.id = e.user_id
        and u.internal
   );

  select count(*) into v_users
    from public.users
   where not internal;

  update public.site_stats
  set total_webhooks  = v_live_webhooks + v_deleted,
      total_endpoints = v_endpoints,
      total_users     = v_users,
      updated_at      = now()
  where id = 1;
end;
$$;

revoke all on function public.refresh_site_stats()
  from public, anon, authenticated;
grant execute on function public.refresh_site_stats() to service_role;

commit;
