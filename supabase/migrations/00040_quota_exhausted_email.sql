-- ============================================================================
-- Migration 00040: claim free users whose quota is used up, for the
-- quota-exhausted email
--
-- When a free user's daily quota runs out, capture_webhook() rejects further
-- webhooks and the receiver answers 429. Nothing told the owner. The web app
-- now polls claim_quota_exhausted_users() and emails each returned user.
--
--  1. users.quota_email_sent_at records the last email. A user is emailed at
--     most once every 7 days; free periods are 24 hours, so a steady sender
--     would otherwise be emailed every day.
--
--  2. claim_quota_exhausted_users() stamps and returns the users to email in
--     one UPDATE, so two web processes polling at once cannot both claim the
--     same user. FOR UPDATE SKIP LOCKED keeps a concurrent poll from waiting
--     on rows another poll is claiming. The caller clears the stamp again
--     when the send fails.
--
-- capture_webhook() is unchanged: exhaustion is read from requests_used and
-- period_end, which it already maintains, so the capture path gains no write.
-- ============================================================================

alter table public.users
  add column if not exists quota_email_sent_at timestamptz;

create or replace function public.claim_quota_exhausted_users(p_limit integer default 50)
returns table (id uuid, email text, request_limit integer, period_end timestamptz)
language sql
set search_path = ''
as $$
  update public.users u
     set quota_email_sent_at = now()
   where u.id in (
     select c.id
       from public.users c
      where c.plan = 'free'
        and c.request_limit > 0
        and c.requests_used >= c.request_limit
        and c.period_end > now()
        and (c.quota_email_sent_at is null or c.quota_email_sent_at < now() - interval '7 days')
      order by c.period_end
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning u.id, u.email, u.request_limit, u.period_end;
$$;

revoke all on function public.claim_quota_exhausted_users(integer) from public;
revoke all on function public.claim_quota_exhausted_users(integer) from anon;
revoke all on function public.claim_quota_exhausted_users(integer) from authenticated;
grant execute on function public.claim_quota_exhausted_users(integer) to service_role;
