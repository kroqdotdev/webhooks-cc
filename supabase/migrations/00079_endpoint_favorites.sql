-- ============================================================================
-- 00079: favourite endpoints
-- ============================================================================
-- A person marks the endpoints they use most; the dashboard lists them first
-- and opens the first of them by default, and the API reports `favorite` on
-- the endpoints it lists and on a single endpoint's read. A favourite
-- belongs to the person, not the endpoint, because a team-shared endpoint is
-- one row seen by every member.
--
-- Lifetime: deleting the account or the endpoint deletes its favourites.
-- Losing access to a shared endpoint does not: the row stays, but every read
-- goes through the endpoints the person can open, so it shows nothing until
-- access returns. Endpoint deletes are rare, so the cascade costs nothing on
-- the capture path.
--
-- Access: service role only, like every user table written through a server
-- route (RLS on, no policies, no grants). Re-runnable.
-- ============================================================================

create table if not exists public.endpoint_favorites (
  user_id     uuid not null references public.users(id) on delete cascade,
  endpoint_id uuid not null references public.endpoints(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, endpoint_id)
);

-- The cascade from endpoints (the primary key serves the one from users).
create index if not exists endpoint_favorites_endpoint
  on public.endpoint_favorites (endpoint_id);

alter table public.endpoint_favorites enable row level security;
revoke all on table public.endpoint_favorites from public, anon, authenticated;

comment on table public.endpoint_favorites is
  'Endpoints a person marked as favourites, listed first in their dashboard. Service role only.';
