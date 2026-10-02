-- ============================================================================
-- Migration 00045: no client writes on endpoints and api_keys
--
-- Every write to these tables goes through a server route with the service
-- role. The routes generate slugs, validate mock responses, rules and
-- notification URLs, enforce the creation rate limits, the ephemeral cap and
-- the 10-key cap, and record the audit trail. The write policies from
-- migration 00011 still let a signed-in user insert, update and delete their
-- own endpoints and insert and delete their own API keys directly through
-- PostgREST, and let anon insert unowned ephemeral endpoints, skipping all of
-- that.
--
-- Same treatment as users in 00037: the write policies go and the table
-- privileges are revoked, so a direct write fails with 42501 instead of being
-- filtered. Every other public table already denies client writes.
--
-- Reads are unchanged: endpoints_select and api_keys_select stay, and the
-- Realtime topic check (can_join_realtime_topic) only reads.
-- ============================================================================

drop policy if exists endpoints_insert on public.endpoints;
drop policy if exists endpoints_update on public.endpoints;
drop policy if exists endpoints_delete on public.endpoints;

drop policy if exists api_keys_insert on public.api_keys;
drop policy if exists api_keys_delete on public.api_keys;

revoke insert, update, delete, truncate, references, trigger
  on public.endpoints, public.api_keys from anon, authenticated;

notify pgrst, 'reload schema';
