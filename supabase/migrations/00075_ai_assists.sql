-- 00075: AI setup and repair (mailhooks roadmap, phase 6).
--
-- A person can ask for a field, a whole layout, or a repair of a field that
-- stopped matching, from emails they pick; the web app sends those emails to
-- the model (with their consent, each time) and shows only patterns that
-- compile with RE2 and find a value in every sample. Each ask uses one of
-- the plan's assists (plan_entitlements.ai_assists) in a rolling 30 days,
-- counted per billing account: the team an endpoint is billed to, else its
-- owner. A use row holds who, when, what kind and how it went, never what
-- was sent.
--
-- Re-runnable.

create table if not exists public.ai_assist_uses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete cascade,
  -- Who asked (a team's member), kept for the audit trail.
  actor_id    uuid references public.users(id) on delete set null,
  endpoint_id uuid references public.endpoints(id) on delete set null,
  kind        text not null check (kind in ('field', 'layout', 'repair')),
  outcome     text check (outcome in ('proposed', 'none', 'failed')),
  created_at  timestamptz not null default now(),
  constraint ai_assist_uses_owner check ((user_id is null) <> (team_id is null))
);
create index if not exists ai_assist_uses_user_time
  on public.ai_assist_uses (user_id, created_at) where user_id is not null;
create index if not exists ai_assist_uses_team_time
  on public.ai_assist_uses (team_id, created_at) where team_id is not null;
create index if not exists ai_assist_uses_actor on public.ai_assist_uses (actor_id)
  where actor_id is not null;
create index if not exists ai_assist_uses_endpoint on public.ai_assist_uses (endpoint_id)
  where endpoint_id is not null;

alter table public.ai_assist_uses enable row level security;
revoke all on table public.ai_assist_uses from anon, authenticated;

-- The account an endpoint's assists count against, and how many it has:
-- the oldest live team share (as capture_webhook() bills), else the owner.
create or replace function public.ai_assist_account(p_endpoint_id uuid)
returns table (user_id uuid, team_id uuid, allowed integer)
language sql
stable
security definer set search_path = ''
as $$
  select null::uuid, t.id, (public.account_entitlements(null, t.id)).ai_assists
    from public.team_endpoints te
    join public.teams t on t.id = te.team_id
   where te.endpoint_id = p_endpoint_id
     and t.subscription_status is not null
  union all
  select e.user_id, null::uuid, (public.account_entitlements(e.user_id, null)).ai_assists
    from public.endpoints e
   where e.id = p_endpoint_id
     and e.user_id is not null
     and not exists (
       select 1 from public.team_endpoints te
         join public.teams t on t.id = te.team_id
        where te.endpoint_id = p_endpoint_id and t.subscription_status is not null
     )
  limit 1
$$;

-- What is left this rolling 30 days.
create or replace function public.ai_assists_left(p_endpoint_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_account record;
  v_used    integer;
begin
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('allowed', 0, 'used', 0);
  end if;
  select count(*) into v_used
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = v_account.user_id or u.team_id = v_account.team_id);
  return jsonb_build_object('allowed', v_account.allowed, 'used', v_used);
end;
$$;

-- Takes one assist, or answers that none is left. Counted under the
-- account's row lock, so two asks at once cannot both take the last one.
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
  select * into v_account from public.ai_assist_account(p_endpoint_id);
  if not found then
    return jsonb_build_object('status', 'no_account');
  end if;
  if v_account.team_id is not null then
    perform 1 from public.teams where id = v_account.team_id for no key update;
  else
    perform 1 from public.users where id = v_account.user_id for no key update;
  end if;
  select count(*) into v_used
    from public.ai_assist_uses u
   where u.created_at > now() - interval '30 days'
     and (u.user_id = v_account.user_id or u.team_id = v_account.team_id);
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

-- How an ask ended; one that failed on our side or the model's is given back.
create or replace function public.finish_ai_assist(p_id uuid, p_outcome text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_outcome = 'failed' then
    delete from public.ai_assist_uses where id = p_id;
  else
    update public.ai_assist_uses set outcome = p_outcome where id = p_id;
  end if;
end;
$$;

revoke all on function public.ai_assist_account(uuid) from public, anon, authenticated;
revoke all on function public.ai_assists_left(uuid) from public, anon, authenticated;
revoke all on function public.take_ai_assist(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_ai_assist(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_assist_account(uuid) to service_role;
grant execute on function public.ai_assists_left(uuid) to service_role;
grant execute on function public.take_ai_assist(uuid, uuid, text) to service_role;
grant execute on function public.finish_ai_assist(uuid, text) to service_role;

notify pgrst, 'reload schema';
