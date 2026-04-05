-- =============================================================
-- 00022_accept_team_invite.sql — Atomic invite acceptance + member limit
-- =============================================================

-- Atomically accept an invite and add the user as a team member.
-- Enforces max 25 members per team under serializable locking.
create or replace function public.accept_team_invite(
  p_user_id uuid,
  p_invite_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team_id uuid;
  v_member_count integer;
  v_max_members integer := 25;
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
  perform 1 from public.teams
  where id = v_team_id
  for update;

  -- Also lock existing memberships for this team
  perform 1 from public.team_members
  where team_id = v_team_id
  for update;

  select count(*) into v_member_count
  from public.team_members
  where team_id = v_team_id;

  if v_member_count >= v_max_members then
    -- Roll back invite to pending so user can retry later
    update public.team_invites
    set status = 'pending'
    where id = p_invite_id;

    return jsonb_build_object('status', 'full');
  end if;

  -- Add as team member (ignore if already a member)
  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, p_user_id, 'member')
  on conflict (team_id, user_id) do nothing;

  return jsonb_build_object('status', 'accepted');
end;
$$;

-- Revoke public access, only service_role can call
revoke all on function public.accept_team_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_team_invite(uuid, uuid) to service_role;
