-- ============================================================================
-- Migration 00029: Agent self-registration (auth.md) — FULL scope
--
-- Supports all three WorkOS auth.md registration flows + claim + revocation:
--   1. anonymous            — immediate unowned whcc_ key, optional in-app claim
--   2. verified_email (OTP) — credential withheld until 6-digit OTP confirmed
--   3. identity_assertion   — ID-JAG (synchronous, JWKS-verified)
--
-- Adds:
--   1. api_keys: user_id NULLABLE (unowned until claimed), scopes text[]
--      (advisory in v1), is_agent_issued, client_name, claimed_at.
--   2. agent_claims: one-time claim/OTP records backing BOTH the in-app claim
--      ceremony (claim_token_hash + post_claim_scopes + status) AND the
--      verified_email OTP flow (email + otp_hash + attempts + expires).
--   3. agent_idjag_jti: ID-JAG / logout-token jti replay-protection store
--      (durable; source of truth for replay).
--   4. Cleanup cron for expired claims (+ orphan unowned keys) and stale jti.
--
-- NOTE: api_keys.user_id becomes NULLABLE. validateApiKeyWithMetadata() MUST be
-- updated in the same PR to accept NULL-user agent keys (default agent
-- plan/quota) — see lib/supabase/api-keys.ts changes. Trusted ID-JAG providers
-- are NOT stored here; they live in env/config (lib/agent/trusted-providers.ts).
-- All new tables are service-role-only (RLS using(false)).
-- ============================================================================

-- 1. api_keys: allow unowned (anonymous/agent) keys + scope/agent metadata
alter table public.api_keys
  alter column user_id drop not null;

alter table public.api_keys
  add column if not exists scopes text[] not null default '{}';

alter table public.api_keys
  add column if not exists is_agent_issued boolean not null default false;

alter table public.api_keys
  add column if not exists client_name text;

alter table public.api_keys
  add column if not exists claimed_at timestamptz;

-- An unowned key MUST be an agent-issued key (manual/device keys always owned).
alter table public.api_keys
  add constraint check_unowned_is_agent
    check (user_id is not null or is_agent_issued);

-- 2. agent_claims: one-time claim + OTP records.
--    flow = 'anonymous' (in-app claim ceremony) | 'verified_email' (OTP).
--    For 'anonymous': api_key_id is set at registration (key issued up front),
--      otp_hash/email are NULL, status pending -> claimed via in-app confirm.
--    For 'verified_email': api_key_id is NULL until OTP verified, then the key
--      is minted and bound; email + otp_hash + attempts are required.
create table public.agent_claims (
  id                  uuid primary key default gen_random_uuid(),
  flow                text not null
                        check (flow in ('anonymous', 'verified_email')),
  claim_token_hash    text not null,            -- sha256(claim_token); plaintext returned once
  api_key_id          uuid references public.api_keys(id) on delete cascade,
  email               text,                     -- verified_email flow only
  otp_hash            text,                     -- sha256(otp); verified_email flow only
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  post_claim_scopes   text[] not null default '{}',
  pre_claim_scopes    text[] not null default '{}',
  client_name         text,
  status              text not null default 'pending'
                        check (status in ('pending', 'claimed')),
  claimed_by_user_id  uuid references public.users(id) on delete set null,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  constraint check_agent_claim_flow check (
    (flow = 'anonymous' and api_key_id is not null and otp_hash is null and email is null)
    or
    (flow = 'verified_email' and email is not null and otp_hash is not null)
  )
);

create unique index agent_claims_claim_token_hash on public.agent_claims(claim_token_hash);
create index agent_claims_api_key_id on public.agent_claims(api_key_id);
create index agent_claims_expires on public.agent_claims(expires_at)
  where status = 'pending';
create index agent_claims_email_pending on public.agent_claims(email)
  where status = 'pending' and flow = 'verified_email';

-- 3. agent_idjag_jti: ID-JAG + logout-token replay protection. A jti seen once
--    is rejected forever (until cleanup past its own exp + skew). Source of
--    truth for replay — durable & consistent (Redis is best-effort/fail-open
--    in this stack and unsuitable for a security gate).
create table public.agent_idjag_jti (
  jti         text primary key,                 -- the assertion's jti claim
  issuer      text not null,                     -- iss (trusted provider URL)
  purpose     text not null default 'id-jag'
                check (purpose in ('id-jag', 'logout')),
  expires_at  timestamptz not null,              -- assertion exp + skew; cleanup boundary
  seen_at     timestamptz not null default now()
);

create index agent_idjag_jti_expires on public.agent_idjag_jti(expires_at);

-- 4. RLS: all new tables service-role only (all direct client access blocked)
alter table public.agent_claims enable row level security;
create policy agent_claims_no_select on public.agent_claims for select using (false);
create policy agent_claims_no_insert on public.agent_claims for insert with check (false);
create policy agent_claims_no_update on public.agent_claims for update using (false);
create policy agent_claims_no_delete on public.agent_claims for delete using (false);

alter table public.agent_idjag_jti enable row level security;
create policy agent_idjag_jti_no_select on public.agent_idjag_jti for select using (false);
create policy agent_idjag_jti_no_insert on public.agent_idjag_jti for insert with check (false);
create policy agent_idjag_jti_no_update on public.agent_idjag_jti for update using (false);
create policy agent_idjag_jti_no_delete on public.agent_idjag_jti for delete using (false);

-- 5. Cleanup: expired/unclaimed claims (+ orphan unowned keys) and stale jti.
create or replace function public.cleanup_expired_agent_claims()
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  deleted_keys integer;
  deleted_claims integer;
begin
  -- Deleting the unowned keys cascades to their anonymous agent_claims rows, so
  -- count those here (1 key : 1 claim) BEFORE they vanish from the next delete.
  delete from public.api_keys ak
  using public.agent_claims ac
  where ac.api_key_id = ak.id
    and ac.status = 'pending'
    and ac.expires_at <= now()
    and ak.user_id is null;
  get diagnostics deleted_keys = row_count;

  -- The remaining expired pending claims (e.g. verified_email claims with no key
  -- yet, so not cascade-removed above).
  delete from public.agent_claims
  where status = 'pending' and expires_at <= now();
  get diagnostics deleted_claims = row_count;

  delete from public.agent_idjag_jti where expires_at <= now();

  return deleted_keys + deleted_claims;
end;
$$;

select cron.schedule(
  'cleanup-expired-agent-claims-every-10-minutes',
  '*/10 * * * *',
  'select public.cleanup_expired_agent_claims();'
);

-- 6. Reload PostgREST schema cache
notify pgrst, 'reload schema';
