-- ============================================================================
-- Migration 00031: atomic OTP-attempt counter for the verified_email claim flow
--
-- The verified_email flow (agent_claims.flow = 'verified_email') guards OTP
-- confirmation with attempts/max_attempts. Incrementing attempts with a
-- read-then-write in application code races under concurrent confirm requests,
-- letting an attacker exceed max_attempts. This RPC does the increment in a
-- single statement so each attempt is counted exactly once.
--
--   - Only bumps rows that are still 'pending'; a claimed claim returns no row,
--     so the function returns NULL (no attempt charged after success).
--   - Returns the post-increment attempt count for the caller to compare against
--     max_attempts. Service-role only (called via admin client).
-- ============================================================================

create or replace function public.increment_agent_claim_attempts(p_claim_id uuid)
returns integer
language sql
security definer set search_path = ''
as $$
  update public.agent_claims
  set attempts = attempts + 1
  where id = p_claim_id and status = 'pending'
  returning attempts;
$$;

-- Reload PostgREST schema cache so the new function is callable via the REST API.
notify pgrst, 'reload schema';
