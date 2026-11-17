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
--     endpoints whose owner is not internal into deleted_webhooks.
--   - An internal account's endpoints are deleted by a BEFORE DELETE trigger
--     on users, while its row still says internal. In the usual cascade
--     (auth.users -> users -> endpoints) the statement trigger above runs
--     after the users row is gone and would count them as a customer's.
--   - What internal accounts' endpoints received so far moves into
--     deleted_webhooks once, so applying this never lowers the public total
--     (00038 keeps it from going down); only their traffic from now on is
--     left out. Apply this file once: a second run would add that sum again.
--
-- Marking an account internal later takes its live counts out of the total
-- at the next refresh (4x a day). Same signatures and grants as 00038; the
-- whole file runs in one transaction so everything changes together.
-- ============================================================================

begin;

-- Locks first, in the order capture_webhook() takes them (users, through the
-- quota decrement, then endpoints), so a capture in flight can never hold one
-- while waiting for the other: users for the trigger created below, then
-- endpoints so that a delete committing between the backfill's snapshot and
-- its row lock is not counted twice (once by the old trigger, once here).
-- Captures and endpoint writes wait until the file commits, a few
-- milliseconds once both are held; each lock waits for writers already
-- running, up to the lock_timeout of the psql recipe. Apply at a quiet hour.
lock table public.users in share row exclusive mode;
lock table public.endpoints in share mode;

-- Under the site_stats row lock, like refresh_site_stats().
update public.site_stats
   set deleted_webhooks = deleted_webhooks + (
     select coalesce(sum(e.request_count), 0)
       from public.endpoints e
       join public.users u on u.id = e.user_id
      where u.internal
   )
 where id = 1;

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

-- SECURITY DEFINER for the same reason as the trigger above: an account
-- deletion runs as GoTrue's role, which cannot delete endpoints itself.
create or replace function public.delete_internal_account_endpoints()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  delete from public.endpoints where user_id = old.id;
  return old;
end;
$$;

revoke all on function public.delete_internal_account_endpoints()
  from public, anon, authenticated;

drop trigger if exists users_internal_endpoints_first on public.users;

create trigger users_internal_endpoints_first
  before delete on public.users
  for each row
  when (old.internal)
  execute function public.delete_internal_account_endpoints();

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
