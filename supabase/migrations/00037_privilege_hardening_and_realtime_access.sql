-- ============================================================================
-- Migration 00037: Privilege hardening, slug index, team-aware realtime reads
--
-- Context: Supabase's default privileges hand `anon` and `authenticated` full
-- DML on every new table in `public` and EXECUTE on every new function. The
-- app never relies on that: every write goes through the service-role client
-- and the browser anon client only SELECTs its own `users` row and subscribes
-- to Realtime. Earlier migrations (00008, 00016, 00025, 00034, 00035) revoked
-- the default grants one function at a time and missed most of them.
--
-- 1. users: the `users_update` policy (00011) had no WITH CHECK and no column
--    limits, and `authenticated` held UPDATE on every column, so any signed-in
--    user could `PATCH /rest/v1/users?id=eq.<self>` over PostgREST and set
--    `plan`, `request_limit`, `requests_used`, `period_end`. Drop the policy
--    and revoke all client DML on the table (SELECT stays, scoped by
--    `users_select`).
-- 2. Functions: revoke EXECUTE from public/anon/authenticated on every
--    non-extension function in `public` (service_role keeps it), and change
--    the default privileges so future CREATE [OR REPLACE] FUNCTION cannot
--    regress. Before this, `increment_user_requests_used`,
--    `check_and_decrement_quota`, `start_free_period`,
--    `check_and_increment_ephemeral`, `cleanup_old_requests` and others were
--    callable with the published anon key.
-- 3. endpoints.slug: 00014 replaced the `(slug)` unique index with one on
--    `lower(slug)`, but every lookup (capture_webhook, the web app, guest
--    polls) filters on the bare column, which an expression index cannot
--    serve, so the hottest lookup in the system was a sequential scan. Add a
--    plain unique index on (slug), enforce lowercase storage with a CHECK so
--    the plain index still guarantees case-insensitive uniqueness, then drop
--    the expression index. (The receiver lowercases the slug before calling
--    capture_webhook, and the web app lowercases before every query.)
-- 4. Realtime: `requests_select` / `endpoints_select` were owner-only, so
--    team members viewing a shared endpoint never received postgres_changes
--    events. Add a SECURITY DEFINER helper and extend both SELECT policies to
--    members of an active team the endpoint is shared with. This only affects
--    what the RLS-scoped clients can read (Realtime and the browser client);
--    server reads already resolve team access in TypeScript.
--
-- Apply with psql in autocommit mode (the documented way): CREATE/DROP INDEX
-- CONCURRENTLY refuse to run inside a transaction block.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. users: no client-side writes at all.
-- ----------------------------------------------------------------------------

drop policy if exists users_update on public.users;

revoke insert, update, delete, truncate, references, trigger
  on public.users from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Functions: service-role only by default.
--
-- Skips functions owned by extensions (pg_trgm operators and support functions
-- live in `public` because the extension was created there; revoking those
-- would break trigram operators for RLS-scoped queries and gains nothing).
-- ----------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass
            and d.objid = p.oid
            and d.deptype = 'e'
       )
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', r.signature);
    execute format('grant execute on routine %s to service_role', r.signature);
  end loop;
end $$;

-- Future functions created by the migration role get no client EXECUTE.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- The auth trigger function is invoked by GoTrue's role; trigger execution does
-- not check EXECUTE at fire time, but keep an explicit grant so a direct call
-- by that role also works.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.handle_new_user() to supabase_auth_admin;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. endpoints.slug: plain unique index + lowercase CHECK.
-- ----------------------------------------------------------------------------

-- An interrupted CREATE INDEX CONCURRENTLY leaves an invalid index behind and
-- IF NOT EXISTS would keep it; drop it (metadata-only) so a retry rebuilds it.
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'endpoints_slug_unique'
       and not i.indisvalid
  ) then
    execute 'drop index public.endpoints_slug_unique';
  end if;
end $$;

create unique index concurrently if not exists endpoints_slug_unique
  on public.endpoints (slug);

-- All rows were lowercased in 00014 and the app only writes lowercase slugs;
-- NOT VALID + VALIDATE avoids holding an exclusive lock during the scan.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'endpoints_slug_lowercase'
      and conrelid = 'public.endpoints'::regclass
  ) then
    alter table public.endpoints
      add constraint endpoints_slug_lowercase check (slug = lower(slug)) not valid;
  end if;
end $$;

alter table public.endpoints validate constraint endpoints_slug_lowercase;

-- Only now is it safe to drop the expression index: uniqueness on (slug) plus
-- the lowercase CHECK is equivalent to uniqueness on lower(slug).
drop index concurrently if exists public.endpoints_slug;

-- ----------------------------------------------------------------------------
-- 4. Team-aware SELECT policies for Realtime.
-- ----------------------------------------------------------------------------

create or replace function public.can_view_team_endpoint(p_endpoint_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.team_endpoints te
      join public.team_members tm on tm.team_id = te.team_id
      join public.teams t on t.id = te.team_id
     where te.endpoint_id = p_endpoint_id
       and tm.user_id = (select auth.uid())
       and t.subscription_status is not null
  );
$$;

-- Policies run as the querying role, so every role that can SELECT from the
-- tables needs EXECUTE here, `anon` included: anon keeps table SELECT (RLS
-- returns nothing for it), and a policy that calls a function anon cannot
-- execute makes every anon read fail with "permission denied" instead of
-- returning zero rows. For anon `auth.uid()` is null, so this returns false.
revoke all on function public.can_view_team_endpoint(uuid) from public;
grant execute on function public.can_view_team_endpoint(uuid) to anon, authenticated, service_role;

drop policy if exists endpoints_select on public.endpoints;
create policy endpoints_select on public.endpoints for select using (
  user_id = (select auth.uid())
  or public.can_view_team_endpoint(id)
);

drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests for select using (
  user_id = (select auth.uid())
  or public.can_view_team_endpoint(endpoint_id)
);

-- Reload PostgREST schema cache (function ACLs and the new helper).
notify pgrst, 'reload schema';
