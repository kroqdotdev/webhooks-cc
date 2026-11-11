-- 00094: AI assists counted for an account, not only for an endpoint.
--
-- ai_assists_left() (00075, 00085) answers for the account an endpoint is
-- billed to. The plan page shows every allowance in one place, so it needs
-- the same answer for a person's own account without naming an endpoint.
-- The count and next_at move into ai_assists_counted(), which both
-- ai_assists_left() and the new ai_assists_left_for_user() call, so the two
-- can never count differently. take_ai_assist() keeps its own count, taken
-- under the account's row lock, with the same filter.
--
-- Re-runnable.

-- Assists counted in the rolling 30 days for one account (a user or a
-- team), and when the next one comes back (see 00085 for next_at).
create or replace function public.ai_assists_counted(
  p_user_id uuid,
  p_team_id uuid,
  p_allowed integer
)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_used integer;
  v_next timestamptz;
begin
  select count(*) into v_used
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = p_user_id or u.team_id = p_team_id)
     and (u.outcome is not null or u.created_at > now() - interval '3 minutes');
  if v_used > 0 then
    select u.created_at + interval '30 days' into v_next
      from public.ai_assist_uses u
     where u.created_at > now() - interval '30 days'
       and (u.user_id = p_user_id or u.team_id = p_team_id)
       and (u.outcome is not null or u.created_at > now() - interval '3 minutes')
     order by u.created_at asc
    offset greatest(v_used - p_allowed, 0)
     limit 1;
  end if;
  return jsonb_build_object('allowed', p_allowed, 'used', v_used, 'next_at', v_next);
end;
$$;

-- Unchanged answer, now counted by ai_assists_counted().
create or replace function public.ai_assists_left(p_endpoint_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_account record;
begin
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('allowed', 0, 'used', 0, 'next_at', null);
  end if;
  return public.ai_assists_counted(v_account.user_id, v_account.team_id, v_account.allowed);
end;
$$;

-- A person's own account: what their endpoints that no team pays for use.
create or replace function public.ai_assists_left_for_user(p_user_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select public.ai_assists_counted(
    p_user_id,
    null,
    coalesce((public.account_entitlements(p_user_id, null)).ai_assists, 0)
  )
$$;

revoke all on function public.ai_assists_counted(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.ai_assists_left(uuid) from public, anon, authenticated;
revoke all on function public.ai_assists_left_for_user(uuid) from public, anon, authenticated;
grant execute on function public.ai_assists_counted(uuid, uuid, integer) to service_role;
grant execute on function public.ai_assists_left(uuid) to service_role;
grant execute on function public.ai_assists_left_for_user(uuid) to service_role;

notify pgrst, 'reload schema';
