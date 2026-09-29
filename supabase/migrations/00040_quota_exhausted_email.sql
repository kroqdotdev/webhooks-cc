-- ============================================================================
-- Migration 00040: quota-exhausted email for free users
--
-- When a free user's daily quota runs out, capture_webhook() rejects further
-- webhooks to their personally billed endpoints and the receiver answers 429.
-- Nothing told the owner. The web app now polls claim_quota_exhausted_users()
-- and emails each returned user.
--
--  1. Two columns on users. quota_email_claimed_at is a short lease taken by
--     the poll; quota_email_sent_at is written only after a successful send
--     (mark_quota_email_sent). A poll that dies between claim and send leaves
--     only the lease, which expires after 15 minutes, so the user is retried
--     instead of being skipped for the 7-day resend window. Free periods are
--     24 hours, so without that window a steady sender would be emailed daily.
--
--  2. claim_quota_exhausted_users() takes the lease and returns the users in
--     one UPDATE, so two web processes polling at once cannot both claim the
--     same user. FOR UPDATE SKIP LOCKED keeps a concurrent poll from waiting
--     on rows another poll is claiming.
--
--  3. Team billing. capture_webhook() bills an endpoint shared with a team
--     that has a subscription (subscription_status is not null) against the
--     team, not the owner, so those endpoints keep capturing when the owner's
--     quota is gone. A user is only claimed when they own at least one
--     personally billed endpoint, and team_billed_endpoints lets the email
--     say which endpoints are unaffected. count_team_billed_endpoints() gives
--     the dashboard banner the same number.
--
-- capture_webhook() is unchanged: exhaustion is read from requests_used and
-- period_end, which it already maintains, so the capture path gains no write.
-- ============================================================================

alter table public.users
  add column if not exists quota_email_sent_at timestamptz,
  add column if not exists quota_email_claimed_at timestamptz;

-- Mirrors the team-billing test in capture_webhook() (migration 00034).
create or replace function public.is_team_billed_endpoint(p_endpoint_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.team_endpoints te
      join public.teams t on t.id = te.team_id
     where te.endpoint_id = p_endpoint_id
       and t.subscription_status is not null
  );
$$;

create or replace function public.count_team_billed_endpoints(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.endpoints e
   where e.user_id = p_user_id
     and public.is_team_billed_endpoint(e.id);
$$;

create or replace function public.claim_quota_exhausted_users(p_limit integer default 50)
returns table (
  id uuid,
  email text,
  request_limit integer,
  period_end timestamptz,
  team_billed_endpoints integer
)
language sql
set search_path = ''
as $$
  update public.users u
     set quota_email_claimed_at = now()
   where u.id in (
     select c.id
       from public.users c
      where c.plan = 'free'
        and c.request_limit > 0
        and c.requests_used >= c.request_limit
        and c.period_end > now()
        and (c.quota_email_sent_at is null or c.quota_email_sent_at < now() - interval '7 days')
        and (c.quota_email_claimed_at is null or c.quota_email_claimed_at < now() - interval '15 minutes')
        and exists (
          select 1
            from public.endpoints e
           where e.user_id = c.id
             and not public.is_team_billed_endpoint(e.id)
        )
      order by c.period_end
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning u.id, u.email, u.request_limit, u.period_end,
            public.count_team_billed_endpoints(u.id);
$$;

-- Called after a successful send: starts the 7-day window, releases the lease.
create or replace function public.mark_quota_email_sent(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.users
     set quota_email_sent_at = now(),
         quota_email_claimed_at = null
   where id = p_user_id;
$$;

revoke all on function public.is_team_billed_endpoint(uuid) from public;
revoke all on function public.is_team_billed_endpoint(uuid) from anon;
revoke all on function public.is_team_billed_endpoint(uuid) from authenticated;
grant execute on function public.is_team_billed_endpoint(uuid) to service_role;

revoke all on function public.count_team_billed_endpoints(uuid) from public;
revoke all on function public.count_team_billed_endpoints(uuid) from anon;
revoke all on function public.count_team_billed_endpoints(uuid) from authenticated;
grant execute on function public.count_team_billed_endpoints(uuid) to service_role;

revoke all on function public.claim_quota_exhausted_users(integer) from public;
revoke all on function public.claim_quota_exhausted_users(integer) from anon;
revoke all on function public.claim_quota_exhausted_users(integer) from authenticated;
grant execute on function public.claim_quota_exhausted_users(integer) to service_role;

revoke all on function public.mark_quota_email_sent(uuid) from public;
revoke all on function public.mark_quota_email_sent(uuid) from anon;
revoke all on function public.mark_quota_email_sent(uuid) from authenticated;
grant execute on function public.mark_quota_email_sent(uuid) to service_role;
