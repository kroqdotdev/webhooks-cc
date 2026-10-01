-- ============================================================================
-- Migration 00042: seat reductions take effect at renewal
--
-- Adding seats charges the prorated price at once (Polar "invoice"). Removing
-- seats now takes effect at the next renewal instead of crediting the unused
-- time: the web app updates the Polar subscription with "next_period", which
-- leaves the seat count, the member cap and the request pool untouched for the
-- rest of the paid period and records the change as the subscription's
-- pending update. Polar applies it when the next period starts.
--
--  1. teams.pending_seats mirrors that pending update (null when none). The
--     web app writes it when a reduction is scheduled or cancelled, and
--     subscription webhooks overwrite it from Polar's pending_update, so the
--     row converges on Polar. pending_seats_as_of is the Polar subscription's
--     modified_at that the value came from: several seat changes in one
--     period share the subscription id and period start, so only this
--     version can tell a late or retried event from the latest state.
--
--  2. schedule_team_seat_reduction() records a reduction under the same row
--     lock accept_team_invite takes, refusing a count below the current
--     members, so a concurrent accept cannot slip in a member the renewal
--     would have no seat for. Scheduling the current seat count cancels the
--     pending reduction.
--
--  3. accept_team_invite() caps members at the scheduled count while a
--     reduction is pending.
--
--  4. update_team_seats() (used for increases) clears pending_seats: Polar
--     drops a pending reduction when seats are added (verified in the
--     sandbox).
-- ============================================================================

alter table public.teams
  add column if not exists pending_seats integer
    check (pending_seats is null or (pending_seats >= 1 and pending_seats <= 1000)),
  add column if not exists pending_seats_as_of timestamptz;

-- ----------------------------------------------------------------------------
-- 2. schedule_team_seat_reduction
-- ----------------------------------------------------------------------------

create or replace function public.schedule_team_seat_reduction(
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

  select id, seats, pending_seats into v_team
  from public.teams
  where id = p_team_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_seats > v_team.seats then
    return jsonb_build_object('status', 'not_a_reduction');
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
  set pending_seats = case when p_seats = v_team.seats then null else p_seats end
  where id = p_team_id;

  return jsonb_build_object('status', 'ok', 'previous_pending_seats', v_team.pending_seats);
end;
$$;

revoke all on function public.schedule_team_seat_reduction(uuid, integer) from public, anon, authenticated;
grant execute on function public.schedule_team_seat_reduction(uuid, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 3. accept_team_invite: unchanged from 00034 except the seat cap.
-- ----------------------------------------------------------------------------

create or replace function public.accept_team_invite(
  p_user_id uuid,
  p_invite_id uuid,
  p_seat_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team_id uuid;
  v_team record;
  v_member_count integer;
begin
  -- Atomically claim the invite: pending → accepted, only if caller is the invited user
  update public.team_invites
  set status = 'accepted'
  where id = p_invite_id
    and invited_user_id = p_user_id
    and status = 'pending'
  returning team_id into v_team_id;

  if v_team_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Lock team row first to serialize concurrent accepts (even when no members exist yet)
  select id, seats, pending_seats, subscription_status into v_team
  from public.teams
  where id = v_team_id
  for update;

  if v_team.subscription_status is null then
    -- Roll back invite to pending so it can be accepted once the team subscribes
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'inactive');
  end if;

  -- Also lock existing memberships for this team
  perform 1 from public.team_members where team_id = v_team_id for update;

  select count(*) into v_member_count
  from public.team_members
  where team_id = v_team_id;

  -- A scheduled reduction caps members now, so the renewal that applies it
  -- can never leave more members than seats.
  if v_member_count >= least(v_team.seats, coalesce(v_team.pending_seats, v_team.seats)) then
    -- Roll back invite to pending so user can retry after seats are added
    update public.team_invites set status = 'pending' where id = p_invite_id;
    return jsonb_build_object('status', 'full');
  end if;

  -- Add as team member (ignore if already a member)
  insert into public.team_members (team_id, user_id, role, polar_seat_id)
  values (v_team_id, p_user_id, 'member', p_seat_id)
  on conflict (team_id, user_id) do nothing;

  return jsonb_build_object('status', 'accepted');
end;
$$;

revoke all on function public.accept_team_invite(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_team_invite(uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- 4. update_team_seats: unchanged from 00035 except clearing pending_seats.
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
      request_limit = p_seats * 100000,
      pending_seats = null
  where id = p_team_id;

  return jsonb_build_object('status', 'ok', 'previous_seats', v_team.seats);
end;
$$;

revoke all on function public.update_team_seats(uuid, integer) from public, anon, authenticated;
grant execute on function public.update_team_seats(uuid, integer) to service_role;

notify pgrst, 'reload schema';
