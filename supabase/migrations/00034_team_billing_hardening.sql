-- ============================================================================
-- Migration 00034: Team billing hardening (PR #310 review follow-ups)
--
-- 1. update_team_seats(): seat changes now happen inside the database, under
--    the same row lock accept_team_invite takes. The previous flow read the
--    member count without a lock and lowered teams.seats only after Polar
--    returned, so a concurrent invite accept could admit a member onto a seat
--    the owner was removing.
-- 2. capture_webhook() ACL: revoke the default public/anon/authenticated
--    EXECUTE that Supabase hands to every new function in `public` and that
--    00033's create-or-replace preserved. The function is security definer, so
--    an anonymous caller holding the published anon key could forge captures
--    for known endpoint slugs over PostgREST, billing quotas and inserting
--    request history. The Rust receiver connects as the postgres role (the
--    function owner) and is unaffected; every server-side caller goes through
--    the service-role client.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- update_team_seats: validate and write a new seat count atomically.
--
-- Locks the team row first, exactly like accept_team_invite, so seat
-- reductions and invite accepts serialize: the member count checked here
-- cannot grow before the seat write lands. The caller (team-billing.ts) is
-- direction-specific: a reduction calls this BEFORE the Polar subscription
-- update (and again with the previous count to roll back if Polar fails); an
-- increase calls Polar first and writes here only after Polar accepted, so a
-- concurrent invite accept can never fill capacity Polar has not confirmed.
--
-- The 100000 request-per-seat multiplier must match TEAM_SEAT_REQUEST_LIMIT
-- in apps/web/lib/supabase/team-billing.ts.
-- ----------------------------------------------------------------------------

create or replace function public.update_team_seats(
  p_team_id uuid,
  p_seats integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team record;
  v_member_count integer;
begin
  if p_seats is null or p_seats < 1 or p_seats > 1000 then
    return jsonb_build_object('status', 'invalid_seats');
  end if;

  select id, seats into v_team
  from public.teams
  where id = p_team_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select count(*) into v_member_count
  from public.team_members
  where team_id = p_team_id;

  if p_seats < v_member_count then
    return jsonb_build_object(
      'status', 'below_members',
      'member_count', v_member_count
    );
  end if;

  update public.teams
  set seats = p_seats,
      request_limit = p_seats * 100000
  where id = p_team_id;

  return jsonb_build_object('status', 'ok', 'previous_seats', v_team.seats);
end;
$$;

revoke all on function public.update_team_seats(uuid, integer) from public, anon, authenticated;
grant execute on function public.update_team_seats(uuid, integer) to service_role;

-- ----------------------------------------------------------------------------
-- capture_webhook ACL hardening (same treatment 00025 and 00033 applied to the
-- cleanup and search RPCs).
-- ----------------------------------------------------------------------------

revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea
) to service_role;

-- Reload PostgREST schema cache so the new RPC is visible
notify pgrst, 'reload schema';
