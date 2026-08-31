-- ============================================================================
-- Migration 00038: Keep site_stats.total_webhooks monotonic across deletes
--
-- Context: refresh_site_stats() (00013) computes
--
--   total_webhooks = sum(endpoints.request_count) + site_stats.deleted_webhooks
--
-- and only cleanup_expired_ephemeral_endpoints() moved request_count into
-- deleted_webhooks before deleting rows. Every other way an endpoint leaves
-- the table dropped its counter from the total:
--
--   - DELETE /api/endpoints/[slug] (dashboard, `whk delete`, SDK, MCP)
--   - account deletion (auth.users -> users -> endpoints cascade)
--   - the agent sandbox rollback
--
-- One user deleting a busy endpoint lowered the landing-page number by the
-- webhooks it had received (prod fell from ~18,500 to ~16,500 in one refresh).
--
-- Fix: a statement-level AFTER DELETE trigger on endpoints adds the
-- request_count of every deleted row to deleted_webhooks, whatever the path
-- and whichever role performs the delete (FK cascades included). The cleanup
-- function loses its own accumulate step so ephemeral deletions are not
-- counted twice.
--
-- Not done here: compensating for counts already lost. The rows are gone, so
-- there is nothing to recompute from; bump deleted_webhooks by hand if the
-- known drop should be restored.
--
-- The whole migration runs in one transaction: between the trigger existing
-- and the cleanup function losing its accumulate step there would otherwise
-- be a window where the 5-minute cleanup cron counts ephemeral deletions
-- twice, and a partial apply would leave exactly that state behind.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Trigger: accumulate request_count of deleted endpoints
--
-- SECURITY DEFINER because the delete may run as a role with no write access
-- to site_stats (GoTrue's role during an account-deletion cascade, for one).
-- Trigger execution does not check EXECUTE at fire time, so no client grant
-- is needed; the default privileges from 00037 keep it service-role only.
-- ----------------------------------------------------------------------------

create or replace function public.accumulate_deleted_endpoint_webhooks()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_count bigint;
begin
  select coalesce(sum(request_count), 0)
    into v_count
    from deleted_endpoints;

  -- Skip the site_stats row lock when nothing was received on the deleted
  -- endpoints (sandbox rollbacks, unused endpoints).
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

drop trigger if exists endpoints_accumulate_deleted_webhooks on public.endpoints;

create trigger endpoints_accumulate_deleted_webhooks
  after delete on public.endpoints
  referencing old table as deleted_endpoints
  for each statement
  execute function public.accumulate_deleted_endpoint_webhooks();

-- ----------------------------------------------------------------------------
-- 2. Cleanup: drop the accumulate step (the trigger covers it now)
--
-- Same body as 00013 minus the accumulate_counts CTE. Return shape unchanged.
-- ----------------------------------------------------------------------------

create or replace function public.cleanup_expired_ephemeral_endpoints()
returns table(
  deleted_endpoints integer,
  deleted_expired_requests integer,
  deleted_orphaned_requests integer
)
language plpgsql
security definer set search_path = ''
as $$
begin
  return query
  with expired_endpoints as (
    select id
    from public.endpoints
    where is_ephemeral = true
      and expires_at is not null
      and expires_at <= now()
  ),
  expired_requests as (
    delete from public.requests
    where endpoint_id in (select id from expired_endpoints)
    returning id
  ),
  deleted_endpoints_cte as (
    delete from public.endpoints
    where id in (select id from expired_endpoints)
    returning id
  )
  select
    (select count(*)::integer from deleted_endpoints_cte),
    (select count(*)::integer from expired_requests),
    0::integer;
end;
$$;

revoke all on function public.cleanup_expired_ephemeral_endpoints()
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_ephemeral_endpoints() to service_role;

commit;
