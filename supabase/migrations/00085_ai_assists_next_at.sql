-- 00085: when the next AI assist comes back.
--
-- Assists are counted over a rolling 30 days (00075), not per billing
-- period, so a person who has used some cannot tell from "12 of 250 left"
-- when more return. ai_assists_left() now also answers next_at: when the
-- oldest assist still counted stops counting (its time plus 30 days), or
-- null when none is counted. It counts exactly as before, with the same
-- filter as take_ai_assist(); only the answer gains a field.
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
  v_oldest  timestamptz;
begin
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('allowed', 0, 'used', 0, 'next_at', null);
  end if;
  select count(*), min(u.created_at) into v_used, v_oldest
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = v_account.user_id or u.team_id = v_account.team_id)
     and (u.outcome is not null or u.created_at > now() - interval '3 minutes');
  return jsonb_build_object(
    'allowed', v_account.allowed,
    'used', v_used,
    'next_at', v_oldest + interval '30 days'
  );
end;
$$;

revoke all on function public.ai_assists_left(uuid) from public, anon, authenticated;
grant execute on function public.ai_assists_left(uuid) to service_role;

notify pgrst, 'reload schema';
