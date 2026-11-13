-- Approvals: "the agent asks, a person approves". A route that a browser
-- session may use, called with an API key or an agent token, answers 202 with
-- an approval instead of acting: a link with a code that the account's owner
-- opens, compares and approves or refuses. The asker polls
-- GET /api/approvals/{id} and, once approved, collects what it asked for
-- exactly once (an API key is minted at that moment, so no secret is ever
-- stored here).
--
-- Who may collect: the agent registration that asked (its access tokens
-- rotate), or else the API key that asked. requested_by_key goes with its key.
--
-- client, country and network are what the approval page shows about the
-- asker, as for device logins (00095): the client as it describes itself,
-- CF-IPCountry, and the requester's /24 (IPv4) or /48 (IPv6), never the
-- address. Rows are deleted a day after they expire.

create table if not exists public.approvals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  action              text not null check (action in ('api_keys.create')),
  params              jsonb not null default '{}'::jsonb,
  -- The one sentence the page and the asker show.
  summary             text not null check (char_length(summary) <= 300),
  user_code           text not null check (char_length(user_code) = 9),
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'denied', 'completed')),
  requested_by_key    uuid references public.api_keys(id) on delete set null,
  requested_by_agent  uuid references public.agent_registrations(id) on delete cascade,
  -- How the page names the asker ("API key CI deploy", "agent Claude Code").
  requester           text not null check (char_length(requester) <= 160),
  client              text check (char_length(client) <= 120),
  country             text check (char_length(country) <= 2),
  network             text check (char_length(network) <= 64),
  -- Non-secret facts about what was done (a new key's prefix and expiry).
  result              jsonb,
  created_at          timestamptz not null default now(),
  -- Pending: until the person must decide. Approved: until the asker must
  -- collect.
  expires_at          timestamptz not null,
  decided_at          timestamptz,
  completed_at        timestamptz
);

create unique index if not exists approvals_user_code on public.approvals (user_code);
create index if not exists approvals_user_pending on public.approvals (user_id)
  where status = 'pending';
create index if not exists approvals_expires on public.approvals (expires_at);
create index if not exists approvals_requested_by_key on public.approvals (requested_by_key);
create index if not exists approvals_requested_by_agent on public.approvals (requested_by_agent);

-- Server routes only (service role); clients have no access.
alter table public.approvals enable row level security;

-- An email to the owner for every approval asked for: off unless they turn
-- it on (an agent running headless, in CI, has nobody to show its link to).
alter table public.users
  add column if not exists approval_emails boolean not null default false;

create or replace function public.cleanup_expired_approvals()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.approvals
  where expires_at <= now() - interval '1 day';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.cleanup_expired_approvals() from public, anon, authenticated;
grant execute on function public.cleanup_expired_approvals() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'cleanup-expired-approvals';
select cron.schedule(
  'cleanup-expired-approvals',
  '41 * * * *',
  'select public.cleanup_expired_approvals();'
);

notify pgrst, 'reload schema';
