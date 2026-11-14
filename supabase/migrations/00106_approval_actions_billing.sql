-- A billing change asked for with an API key or agent token (a plan, its
-- interval, seats, add-on units, the overage maximum, cancelling or keeping
-- the subscription) waits for the owner's approval (billing.change in
-- lib/approvals/actions.ts): it can charge the account's card. The quote is
-- kept in params, and the change runs only while a fresh quote still
-- matches it.
--
-- Re-runnable, in autocommit mode as AGENTS.md runs migrations.

-- One statement drops and adds the check, so a lock timeout leaves the old
-- check in place, never none. It is added NOT VALID (no scan under the
-- ACCESS EXCLUSIVE lock) and validated in its own statement, under a lock
-- that lets reads and writes go on; every row already passes it.
alter table public.approvals
  drop constraint if exists approvals_action_check,
  add constraint approvals_action_check
    check (action in (
      'api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename',
      'google.connect', 'google.pick', 'ai.assist', 'teams.delete', 'teams.invite',
      'billing.change'
    )) not valid;

alter table public.approvals validate constraint approvals_action_check;

-- One billing change at a time per billing account (`user:<id>` or
-- `team:<id>`): an approved change is quoted again and made while it holds
-- the account's lease, so two approvals approved together cannot both pass
-- against the state before either. A lease rather than an advisory lock,
-- because the re-quote and the Polar calls span many PostgREST requests,
-- each its own transaction; it expires, so a crashed process holds nobody
-- up for long.
create table if not exists public.billing_change_locks (
  account_key text primary key,
  holder      uuid not null,
  expires_at  timestamptz not null
);

-- Server routes only (service role); clients have no access.
alter table public.billing_change_locks enable row level security;
revoke all on table public.billing_change_locks from anon, authenticated;

-- Takes the account's lease for `p_seconds` when nobody holds it (or the
-- holder's lease ran out). True when `p_holder` now holds it.
create or replace function public.claim_billing_change_lock(
  p_account_key text,
  p_holder uuid,
  p_seconds integer
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.billing_change_locks as l (account_key, holder, expires_at)
  values (p_account_key, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (account_key) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at
    where l.expires_at <= now();
  return found;
end;
$$;

-- Gives the lease back, only by the holder that took it.
create or replace function public.release_billing_change_lock(p_account_key text, p_holder uuid)
returns void
language sql
security definer set search_path = ''
as $$
  delete from public.billing_change_locks
  where account_key = p_account_key
    and holder = p_holder;
$$;

revoke all on function public.claim_billing_change_lock(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_billing_change_lock(text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_billing_change_lock(text, uuid, integer) to service_role;
grant execute on function public.release_billing_change_lock(text, uuid) to service_role;

notify pgrst, 'reload schema';
