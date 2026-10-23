-- ============================================================================
-- 00062: shared request snapshots
-- ============================================================================
-- A signed-in user can publish one captured HTTP request as a read-only page
-- at /s/{token}, to paste into a pull request, a ticket or a chat. The row
-- holds a frozen copy (snapshot) taken when the link was made, with
-- credential headers removed by the web app, so the link keeps working after
-- the request ages out of retention or is cleared, and never shows more than
-- it showed when it was made.
--
-- Lifetime: until expires_at (the web app offers 1 to 30 days; the check
-- allows up to 91) or until the user revokes it. Deleting the endpoint or the
-- account deletes its shares. The request going away does not: request_id is
-- kept only so the dashboard can list a request's links, and it has no
-- foreign key, because a reference to public.requests would add a cascade
-- trigger to every delete on that table, retention cleanup included.
--
-- Access: service role only, like every user table written through a server
-- route (RLS on, no policies, no grants). The public page reads a row by its
-- token with the admin client; the token carries 128 random bits and is the
-- capability, like an endpoint slug.
-- ============================================================================

create table if not exists public.request_shares (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  user_id     uuid not null references public.users(id) on delete cascade,
  endpoint_id uuid not null references public.endpoints(id) on delete cascade,
  request_id  uuid,
  snapshot    jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  constraint request_shares_lifetime
    check (expires_at > created_at and expires_at <= created_at + interval '91 days')
);

-- Counting and listing a user's live shares, and the cascade from users.
create index if not exists request_shares_user_expires
  on public.request_shares (user_id, expires_at);
-- The cascade from endpoints.
create index if not exists request_shares_endpoint
  on public.request_shares (endpoint_id);
-- The links of one request, shown in its share dialog.
create index if not exists request_shares_request
  on public.request_shares (request_id)
  where request_id is not null;
-- The hourly cleanup.
create index if not exists request_shares_expires
  on public.request_shares (expires_at);

alter table public.request_shares enable row level security;
revoke all on table public.request_shares from public, anon, authenticated;

comment on table public.request_shares is
  'Read-only snapshots of captured requests, published at /s/{token} until expires_at. Service role only.';

-- Expired links already answer 404 (the page checks expires_at); this only
-- removes their rows.
create or replace function public.cleanup_expired_request_shares()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.request_shares where expires_at < now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.cleanup_expired_request_shares() from public, anon, authenticated;
grant execute on function public.cleanup_expired_request_shares() to service_role;

-- pg_cron 1.3+ already upserts named jobs; unscheduling first keeps a re-run
-- from ever leaving a duplicate.
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-expired-request-shares';
select cron.schedule(
  'cleanup-expired-request-shares',
  '41 * * * *',
  'select public.cleanup_expired_request_shares();'
);

notify pgrst, 'reload schema';
