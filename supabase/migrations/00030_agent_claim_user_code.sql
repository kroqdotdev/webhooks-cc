-- ============================================================================
-- Migration 00030: human-friendly claim code for the anonymous agent flow
--
-- Adds a short, unambiguous claim code (e.g. "ABCD-EFGH") to agent_claims,
-- analogous to device_codes.user_code, so a human can claim an anonymous agent
-- credential by TYPING the code at /agent/claim instead of opening the long
-- claim_token URL. The existing claim_token (clm_...) URL path keeps working.
--
--   - user_code is only populated for `anonymous` claims (verified_email uses
--     an emailed OTP, not an in-app human-typed code), so the column is NULLABLE.
--   - A partial UNIQUE index on (user_code) WHERE user_code IS NOT NULL keeps
--     codes collision-free among the rows that have one, without forcing a value
--     on verified_email rows.
--   - A lookup index on the same predicate keeps code-entry claims fast.
--
-- Codes are short-lived (claim TTL is 15 minutes) and high-entropy enough for an
-- interactive window: alphabet ABCDEFGHJKMNPQRSTUVWXYZ23456789 (31 chars, no
-- ambiguous 0/O/1/I/L), 8 significant chars -> 31^8 ≈ 8.5e11 combinations. The
-- confirm path is session-authenticated (a logged-in human), so this is not an
-- unauthenticated brute-force surface.
-- ============================================================================

alter table public.agent_claims
  add column if not exists user_code text;

-- Collision-free among rows that carry a code (anonymous claims).
create unique index if not exists agent_claims_user_code
  on public.agent_claims(user_code)
  where user_code is not null;

-- Fast code-entry lookups while a claim is still pending.
create index if not exists agent_claims_user_code_pending
  on public.agent_claims(user_code)
  where status = 'pending' and user_code is not null;

-- Reload PostgREST schema cache so the new column is queryable via the REST API.
notify pgrst, 'reload schema';
