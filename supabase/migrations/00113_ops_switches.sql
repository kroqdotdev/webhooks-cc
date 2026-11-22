-- 00113: switches staff turn off from the operations center
--
-- ops_switches holds one row per feature that staff can turn off for
-- everyone at once from /ops, without a deploy or an env change. The first
-- is AI assists: with it off, the web app stops offering AI setup and
-- repair, refuses new asks, and refuses approvals an agent asked for before
-- it was turned off when the owner approves them.
--
-- The web app reads the switch with a short cache, so take_ai_assist() reads
-- it too and answers 'paused' before it takes anything: once the switch row
-- says off, no process asks the model again, whatever its cache holds.
--
-- The names are a CHECK list, so a new switch is a migration that widens
-- ops_switches_name and seeds its row, together with OpsSwitchName and
-- OPS_SWITCHES in the web app.
--
-- A row records who changed it last, when and why; every change is audited
-- by the route as well. Service-role only. Re-runnable. Apply in autocommit
-- mode.
-- ============================================================================


-- 1. The switches ------------------------------------------------------------

create table if not exists public.ops_switches (
  name       text primary key
             constraint ops_switches_name check (name in ('ai_assists')),
  off        boolean not null default false,
  -- Why it was last changed, in a few words (shown on /ops).
  reason     text constraint ops_switches_reason check (char_length(reason) <= 500),
  -- No foreign key: a staff account that is later deleted keeps the record.
  changed_by uuid,
  changed_at timestamptz not null default now()
);

alter table public.ops_switches enable row level security;
revoke all on table public.ops_switches from public, anon, authenticated;
grant select, insert, update on table public.ops_switches to service_role;

insert into public.ops_switches (name) values ('ai_assists')
on conflict (name) do nothing;


-- 2. take_ai_assist() refuses while AI assists are off -----------------------
--
-- As in 00075, with the switch read first.

create or replace function public.take_ai_assist(
  p_endpoint_id uuid,
  p_actor_id    uuid,
  p_kind        text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_account record;
  v_used    integer;
  v_id      uuid;
begin
  if p_kind not in ('field', 'layout', 'repair') then
    raise exception 'invalid kind: %', p_kind using errcode = '22023';
  end if;
  if exists (select 1 from public.ops_switches s where s.name = 'ai_assists' and s.off) then
    return jsonb_build_object('status', 'paused');
  end if;
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;
  -- The person first (the busy check below is theirs, whichever account
  -- pays), then the account; always in this order.
  perform pg_advisory_xact_lock(hashtextextended('ai_assist:' || p_actor_id::text, 0));
  if v_account.team_id is not null then
    perform 1 from public.teams where id = v_account.team_id for no key update;
  else
    perform 1 from public.users where id = v_account.user_id for no key update;
  end if;
  -- An ask still unfinished after the 3 minutes one may take was abandoned
  -- (the process ended before it could say how it went): our side failed,
  -- so it is not counted, here or in ai_assists_left().
  select count(*) into v_used
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = v_account.user_id or u.team_id = v_account.team_id)
     and (u.outcome is not null or u.created_at > now() - interval '3 minutes');
  -- One ask at a time per person: another is still waiting for the model.
  -- The web app ends an ask within 80 seconds; the window is longer.
  perform 1
     from public.ai_assist_uses u
    where u.actor_id = p_actor_id
      and u.outcome is null
      and u.created_at > now() - interval '3 minutes';
  if found then
    return jsonb_build_object('status', 'busy');
  end if;
  if v_used >= v_account.allowed then
    return jsonb_build_object('status', 'none_left', 'allowed', v_account.allowed, 'used', v_used);
  end if;
  insert into public.ai_assist_uses (user_id, team_id, actor_id, endpoint_id, kind)
  values (v_account.user_id, v_account.team_id, p_actor_id, p_endpoint_id, p_kind)
  returning id into v_id;
  return jsonb_build_object(
    'status', 'ok', 'id', v_id, 'allowed', v_account.allowed, 'used', v_used + 1
  );
end;
$$;

revoke all on function public.take_ai_assist(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.take_ai_assist(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
