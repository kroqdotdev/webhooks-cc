-- 00085: when the next AI assist comes back.
--
-- Assists are counted over a rolling 30 days (00075), not per billing
-- period, so a person who has used some cannot tell from "12 of 250 left"
-- when more return. ai_assists_left() now also answers next_at: when the
-- count next drops in a way that matters, or null when none is counted.
-- With assists left, that is when the oldest counted one stops counting.
-- With none left, one comes back only once used falls below allowed, so it
-- is when the (used - allowed + 1)th oldest stops counting; after a move to
-- a smaller plan that is later than the oldest. It counts exactly as
-- before, with the same filter as take_ai_assist(); only the answer gains
-- a field.
--
-- Re-runnable.

create or replace function public.ai_assists_left(p_endpoint_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_account record;
  v_used    integer;
  v_next    timestamptz;
begin
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('allowed', 0, 'used', 0, 'next_at', null);
  end if;
  select count(*) into v_used
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = v_account.user_id or u.team_id = v_account.team_id)
     and (u.outcome is not null or u.created_at > now() - interval '3 minutes');
  if v_used > 0 then
    select u.created_at + interval '30 days' into v_next
      from public.ai_assist_uses u
     where u.created_at > now() - interval '30 days'
       and (u.user_id = v_account.user_id or u.team_id = v_account.team_id)
       and (u.outcome is not null or u.created_at > now() - interval '3 minutes')
     order by u.created_at asc
    offset greatest(v_used - v_account.allowed, 0)
     limit 1;
  end if;
  return jsonb_build_object(
    'allowed', v_account.allowed,
    'used', v_used,
    'next_at', v_next
  );
end;
$$;

revoke all on function public.ai_assists_left(uuid) from public, anon, authenticated;
grant execute on function public.ai_assists_left(uuid) to service_role;

notify pgrst, 'reload schema';
