-- ============================================================================
-- Migration 00093: a getting-started email for new accounts
--
-- New accounts got no email from us beyond GoTrue's confirmation. The web app
-- now polls claim_welcome_email_users() and sends each returned account one
-- short email with its dashboard link and the ways in (lib/welcome-emails.ts),
-- the same way as the quota email of migration 00040.
--
--  1. Two columns on users. welcome_email_claimed_at is a short lease taken
--     by the poll; welcome_email_sent_at is written just before the send by
--     mark_welcome_email_sent(), which answers true only for the caller that
--     set it. The email therefore goes out at most once: not after a database
--     error, not when a slow batch outlives its lease and another poller
--     claims the account. A failed send is not retried, since the transport
--     cannot tell whether the server took the message first; a missing
--     welcome is the better failure.
--
--  2. Accounts that exist when this runs never get the email. The column is
--     added with DEFAULT now() and the default is dropped in the same
--     transaction: Postgres stores a non-volatile default for existing rows
--     in the catalog, so they all read as handled at the migration's time
--     without a table rewrite, a row update or a trigger firing, and accounts
--     created afterwards start at NULL. For those rows the value means
--     "never to be sent", not that an email went out. The transaction keeps
--     a signup from landing between the two statements and inheriting the
--     default. Running the file again changes nothing.
--
--  3. claim_welcome_email_users() takes the lease and returns the accounts in
--     one UPDATE, so two web processes polling at once cannot both claim the
--     same account. It claims an account between 30 minutes and 7 days after
--     signup, once its email is confirmed (an OAuth signup is at once). The
--     30 minutes keep it apart from the confirmation email; the 7 days are
--     the second guard for point 2 and mean an account confirmed late is
--     simply never welcomed. It reads auth.users, which service_role cannot,
--     hence SECURITY DEFINER; like every function here it is service-role
--     only.
--
-- users is small and the poll runs every 10 minutes, so the claim scans it
-- without an index of its own.
-- ============================================================================

begin;

alter table public.users
  add column if not exists welcome_email_sent_at timestamptz default now(),
  add column if not exists welcome_email_claimed_at timestamptz;

alter table public.users
  alter column welcome_email_sent_at drop default;

commit;

comment on column public.users.welcome_email_sent_at is
  'When the getting-started email was sent. Accounts older than migration 00093 hold its time and were never sent one.';

create or replace function public.claim_welcome_email_users(p_limit integer default 50)
returns table (
  id uuid,
  email text,
  home_site text
)
language sql
security definer
set search_path = ''
as $$
  update public.users u
     set welcome_email_claimed_at = now()
   where u.id in (
     select c.id
       from public.users c
      where c.welcome_email_sent_at is null
        and c.created_at <= now() - interval '30 minutes'
        and c.created_at > now() - interval '7 days'
        and (c.welcome_email_claimed_at is null
             or c.welcome_email_claimed_at < now() - interval '15 minutes')
        and exists (
          select 1
            from auth.users a
           where a.id = c.id
             and a.email_confirmed_at is not null
        )
      order by c.created_at
      limit greatest(p_limit, 0)
      for update of c skip locked
   )
  returning u.id, u.email, u.home_site;
$$;

-- Called just before the send. Answers true only for the call that moves the
-- account from unsent to sent, so of two pollers that hold the same account
-- (a lease that ran out under a slow batch) exactly one sends.
-- An earlier draft returned void; replacing a function cannot change that.
drop function if exists public.mark_welcome_email_sent(uuid);
create or replace function public.mark_welcome_email_sent(p_user_id uuid)
returns boolean
language sql
set search_path = ''
as $$
  with marked as (
    update public.users
       set welcome_email_sent_at = now(),
           welcome_email_claimed_at = null
     where id = p_user_id
       and welcome_email_sent_at is null
    returning 1
  )
  select exists (select 1 from marked);
$$;

revoke all on function public.claim_welcome_email_users(integer) from public, anon, authenticated;
grant execute on function public.claim_welcome_email_users(integer) to service_role;

revoke all on function public.mark_welcome_email_sent(uuid) from public, anon, authenticated;
grant execute on function public.mark_welcome_email_sent(uuid) to service_role;
