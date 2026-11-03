-- ============================================================================
-- 00088: two-factor sign-in carries across a site switch
-- ============================================================================
-- Switching between webhooks.cc and mailhooks.cc signs the person in on the
-- other site with a fresh magic-link session (lib/site-switch.ts), which
-- GoTrue always rates aal1, so an account with an authenticator had to enter
-- its code again on every switch. GoTrue offers no way to raise a session to
-- aal2 from the server, so the app records it instead: when the session the
-- switch started from had passed the second factor, /auth/switch/finish adds
-- the new session's id here, and every check that wants aal2 also accepts a
-- session listed here (lib/mfa.ts on the server, session_mfa_ok() for RLS).
-- A row goes with its session (signing out deletes it), and only a session
-- that had passed the code can list another, so a password alone still gets
-- nothing.
--
-- Service-role only. Re-runnable. Apply in autocommit mode.
-- ============================================================================

create table if not exists public.mfa_trusted_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists mfa_trusted_sessions_user
  on public.mfa_trusted_sessions (user_id);

alter table public.mfa_trusted_sessions enable row level security;
revoke all on table public.mfa_trusted_sessions from public, anon, authenticated;
grant select, insert, delete on table public.mfa_trusted_sessions to service_role;

-- 00087's check, now also passing a session a switch carried the factor to.
create or replace function public.session_mfa_ok()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select auth.uid() is null
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = auth.uid() and f.status = 'verified'
      )
      or exists (
        select 1 from public.mfa_trusted_sessions t
         where t.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
           and t.user_id = auth.uid()
      );
$$;

revoke all on function public.session_mfa_ok() from public;
grant execute on function public.session_mfa_ok() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
