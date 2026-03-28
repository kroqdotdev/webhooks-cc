-- =============================================================
-- 00016_teams_procedures.sql — Atomic team creation + limits
-- =============================================================

-- Atomic team creation: insert team + owner member in one transaction.
-- Enforces per-user team limit (max 10 owned teams).
create or replace function public.create_team_with_owner(
  p_user_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_team_id uuid;
  v_owned_count integer;
  v_max_teams integer := 10;
begin
  -- Check team limit
  select count(*) into v_owned_count
  from public.team_members
  where user_id = p_user_id and role = 'owner';

  if v_owned_count >= v_max_teams then
    return jsonb_build_object('error', 'You can own at most ' || v_max_teams || ' teams');
  end if;

  -- Insert team
  insert into public.teams (name, created_by)
  values (p_name, p_user_id)
  returning id into v_team_id;

  -- Insert owner membership
  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, p_user_id, 'owner');

  return jsonb_build_object(
    'id', v_team_id,
    'name', p_name,
    'created_by', p_user_id,
    'created_at', now()
  );
end;
$$;

-- Revoke public access, only service_role can call
revoke all on function public.create_team_with_owner(uuid, text) from public, anon, authenticated;
grant execute on function public.create_team_with_owner(uuid, text) to service_role;

-- Add index on team_invites for pending status lookups
create index if not exists team_invites_user_status
  on public.team_invites(invited_user_id, status);
