-- 00053: requests follow their endpoint when it gets an owner.
--
-- capture_webhook() copies endpoints.user_id onto each request it stores. A
-- guest endpoint has no owner, so neither do its requests, and claiming it
-- after signing in (POST /api/endpoints/claim) only changed the endpoint.
-- Its earlier requests kept user_id null: search never found them
-- (search_requests filters r.user_id) and free-plan retention never deleted
-- them (cleanup_free_user_requests joins on it). Production had 35 such
-- requests on 10 endpoints on 2026-10-08.
--
-- A trigger now hands them to the new owner in the claim's own transaction,
-- whatever the path (the guest claim today, adopting agent sandbox endpoints
-- later). It fires only when an endpoint goes from no owner to an owner, so
-- captures, which update other columns, never fire it. A capture whose
-- snapshot predates the claim can still store one request without an owner
-- in the moment of the claim; that is rare enough not to slow every capture
-- with a lock.
--
-- The backfill below fixes the endpoints claimed so far. Trigger and backfill
-- run in one transaction so no claim falls between them.

begin;

-- SECURITY DEFINER for the same reason as 00038: the update on endpoints may
-- run as a role without write access to requests. Trigger execution does not
-- check EXECUTE, so no client grant is needed.
create or replace function public.adopt_endpoint_requests()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.requests
     set user_id = new.user_id
   where endpoint_id = new.id
     and user_id is null;
  return null;
end;
$$;

revoke execute on function public.adopt_endpoint_requests() from public, anon, authenticated;

drop trigger if exists endpoints_adopt_requests on public.endpoints;
create trigger endpoints_adopt_requests
  after update of user_id on public.endpoints
  for each row
  when (old.user_id is null and new.user_id is not null)
  execute function public.adopt_endpoint_requests();

update public.requests r
   set user_id = e.user_id
  from public.endpoints e
 where r.endpoint_id = e.id
   and r.user_id is null
   and e.user_id is not null;

commit;
