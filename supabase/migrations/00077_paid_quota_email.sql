-- ============================================================================
-- 00077: the quota-exhausted email reaches paid accounts too
-- ============================================================================
-- claim_quota_exhausted_users() (00040, last changed in 00065) only picked
-- free accounts, so a Pro account that used up its period learned of it from
-- the 429s and the dashboard banner alone. Every personal account now
-- qualifies once it is past everything capture_webhook() would still take:
-- the allowance (request_limit + block_requests) and whatever
-- has_extra_request() offers (one-time blocks, overage below its maximum).
--
-- Resend window: a free period lasts 24 hours, so a free account keeps the
-- 7-day window. A paid period lasts 30 days, so a paid account is emailed at
-- most once per period: again only when the last email predates its
-- period_start (an email sent while it was still free does not count).
--
-- The result gains plan, block_requests and cancel_at_period_end, so the web
-- app can pick the copy (extra requests instead of an upgrade) and state the
-- whole allowance. A changed result type needs drop and create, which also
-- drops the grants; they are given again below.
--
-- Deploy order: deploy the web release that reads these columns first, then
-- apply this file. The release before it would send a paid account the free
-- copy ("Upgrade to Pro"); the new one treats a missing plan as free, which
-- is all the old function returns.
--
-- Team pools are not covered: when a team's pool runs out its members get
-- neither this email nor the banner.
--
-- Numbered 00077 because the open mailhooks stack holds 00067 to 00076; it
-- depends on nothing there.
-- ============================================================================

begin;

drop function if exists public.claim_quota_exhausted_users(integer);

create function public.claim_quota_exhausted_users(p_limit integer default 50)
returns table (
  id uuid,
  email text,
  plan text,
  request_limit integer,
  block_requests integer,
  period_end timestamptz,
  cancel_at_period_end boolean,
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
      where c.request_limit > 0
        and c.period_end > now()
        and c.requests_used >= c.request_limit + c.block_requests
        and not public.has_extra_request(c.id, null)
        and (c.quota_email_sent_at is null
             or c.quota_email_sent_at < case
                  when c.plan = 'free' then now() - interval '7 days'
                  else coalesce(c.period_start, now() - interval '7 days')
                end)
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
  returning u.id, u.email, u.plan, u.request_limit, u.block_requests, u.period_end,
            u.cancel_at_period_end, public.count_team_billed_endpoints(u.id);
$$;

revoke all on function public.claim_quota_exhausted_users(integer) from public, anon, authenticated;
grant execute on function public.claim_quota_exhausted_users(integer) to service_role;

commit;
