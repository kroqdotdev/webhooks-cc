-- ============================================================================
-- Migration 00008: RLS hardening
--
-- Fixes three security regressions identified in the security audit:
--
-- 1. device_codes: anonymous users could read/insert rows, enabling API key
--    minting without login. Lock down to service_role only.
--
-- 2. endpoints: anonymous users could enumerate all ephemeral endpoints and
--    insert ownerless non-ephemeral rows. Remove ephemeral bypass from SELECT,
--    constrain anonymous INSERT to ephemeral-only with bounded expiry.
--
-- 3. requests: anonymous users could read all requests attached to ephemeral
--    endpoints. Remove the ephemeral subquery bypass.
-- ============================================================================

-- 1. device_codes: block all anonymous/authenticated direct access.
--    All device code operations go through API routes using service_role.
drop policy if exists device_codes_select on public.device_codes;
drop policy if exists device_codes_insert on public.device_codes;

create policy device_codes_select on public.device_codes
  for select using (false);

create policy device_codes_insert on public.device_codes
  for insert with check (false);

-- 2a. endpoints SELECT: only owner can see their own endpoints.
--     Guest reads are mediated by server API routes using service_role.
drop policy if exists endpoints_select on public.endpoints;

create policy endpoints_select on public.endpoints
  for select using (user_id = auth.uid());

-- 2b. endpoints INSERT: anonymous inserts must be ephemeral with a bounded expiry.
drop policy if exists endpoints_insert on public.endpoints;

create policy endpoints_insert on public.endpoints
  for insert with check (
    (user_id is null and is_ephemeral = true and expires_at is not null)
    or user_id = auth.uid()
  );

-- 3a. requests SELECT: only owner can see requests for their endpoints.
--     Guest request reads are mediated by server API routes using service_role.
drop policy if exists requests_select on public.requests;

create policy requests_select on public.requests
  for select using (user_id = auth.uid());

-- 3b. requests INSERT: block all direct client inserts.
--     Only the Rust receiver inserts requests, using service_role (bypasses RLS).
drop policy if exists requests_insert on public.requests;

create policy requests_insert on public.requests
  for insert with check (false);
