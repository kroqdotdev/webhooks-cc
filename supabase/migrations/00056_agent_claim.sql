-- 00056: the agent claim ceremony (auth.md v0.6, Step 4).
--
-- A human connects an agent registration to their account: the agent starts
-- an attempt (a link carrying a high-entropy attempt token, and a 6-digit
-- code it shows the human), the human signs in, opens the link and types the
-- code. The registration then belongs to that account, its sandbox
-- endpoints become the account's own endpoints, and the agent collects
-- account-scoped credentials with its claim token.
--
-- 1. start_agent_claim_attempt(): a new attempt replaces the previous one
--    (old links stop working), at most p_max_attempts per registration.
-- 2. complete_agent_claim(): in one transaction, checks the attempt, the
--    signed-in user's email against the email the agent named, the code
--    (a wrong one counts; enough wrong ones end the attempt) and the user's
--    connected-agent cap; then claims the registration, adopts its sandbox
--    endpoints (00053's trigger hands their requests over) and deletes its
--    pre-claim tokens.
-- 3. deny_agent_claim_attempt(): the human refuses; the agent's next poll
--    answers access_denied.
-- 4. revoke_agent_registration(): a user disconnects an agent; its tokens go
--    in the same statement.
-- 5. claim_device_code(): the key cap no longer counts agent tokens, which
--    are capped as connected agents instead.
--
-- Codes and tokens arrive hashed; nothing here sees a secret.
--
-- Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. Start (or replace) the claim attempt of a live, unclaimed registration.
create or replace function public.start_agent_claim_attempt(
  p_claim_token_hash   text,
  p_attempt_token_hash text,
  p_user_code_hash     text,
  p_login_hint         text,
  p_attempt_seconds    integer,
  p_max_attempts       integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration public.agent_registrations%rowtype;
  v_expires      timestamptz;
  v_hint         text;
begin
  select * into v_registration
    from public.agent_registrations
   where claim_token_hash = p_claim_token_hash
     for update;

  if not found or v_registration.revoked_at is not null then
    return jsonb_build_object('status', 'invalid_claim_token');
  end if;
  if v_registration.claimed_at is not null then
    return jsonb_build_object('status', 'claimed_or_in_flight');
  end if;
  if v_registration.expires_at <= now() then
    return jsonb_build_object('status', 'claim_expired');
  end if;
  -- service_auth is bound to the email it registered with; an anonymous
  -- registration names one with each attempt.
  if v_registration.kind = 'service_auth' then
    if p_login_hint is not null
       and p_login_hint is distinct from v_registration.attempt_login_hint then
      return jsonb_build_object('status', 'login_hint_mismatch');
    end if;
    v_hint := v_registration.attempt_login_hint;
  else
    if p_login_hint is null then
      return jsonb_build_object('status', 'login_hint_required');
    end if;
    v_hint := p_login_hint;
  end if;
  if v_registration.attempts_issued >= p_max_attempts then
    return jsonb_build_object('status', 'too_many_attempts');
  end if;

  -- The code never outlives the registration.
  v_expires := least(now() + make_interval(secs => p_attempt_seconds), v_registration.expires_at);

  update public.agent_registrations
     set attempt_token_hash     = p_attempt_token_hash,
         attempt_user_code_hash = p_user_code_hash,
         attempt_login_hint     = v_hint,
         attempt_expires_at     = v_expires,
         attempt_failures       = 0,
         attempt_denied_at      = null,
         attempts_issued        = attempts_issued + 1
   where id = v_registration.id;

  return jsonb_build_object(
    'status', 'ok',
    'registration_id', v_registration.id,
    'kind', v_registration.kind,
    'attempt', v_registration.attempts_issued + 1,
    'attempt_expires_at', v_expires,
    'registration_expires_at', v_registration.expires_at
  );
end;
$$;

revoke all on function public.start_agent_claim_attempt(text, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.start_agent_claim_attempt(text, text, text, text, integer, integer)
  to service_role;

-- 2. Complete a claim for the signed-in user.
create or replace function public.complete_agent_claim(
  p_attempt_token_hash text,
  p_user_code_hash     text,
  p_user_id            uuid,
  p_user_email         text,
  p_max_agents         integer,
  p_max_failures       integer,
  p_max_adopt          integer default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration public.agent_registrations%rowtype;
  v_connected    integer;
  v_ever         integer;
  v_adopted      text[];
begin
  select * into v_registration
    from public.agent_registrations
   where attempt_token_hash = p_attempt_token_hash
     for update;

  if not found or v_registration.revoked_at is not null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_registration.claimed_at is not null then
    return jsonb_build_object('status', 'already_claimed', 'registration_id', v_registration.id);
  end if;
  if v_registration.expires_at <= now()
     or v_registration.attempt_expires_at is null
     or v_registration.attempt_expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'registration_id', v_registration.id);
  end if;
  if v_registration.attempt_denied_at is not null then
    return jsonb_build_object('status', 'denied', 'registration_id', v_registration.id);
  end if;
  if v_registration.attempt_failures >= p_max_failures then
    return jsonb_build_object('status', 'locked', 'registration_id', v_registration.id);
  end if;
  -- Only the human the agent named may complete it. Not a failed guess.
  if lower(coalesce(p_user_email, '')) is distinct from v_registration.attempt_login_hint then
    return jsonb_build_object('status', 'wrong_account', 'registration_id', v_registration.id);
  end if;

  if v_registration.attempt_user_code_hash is distinct from p_user_code_hash then
    update public.agent_registrations
       set attempt_failures = attempt_failures + 1
     where id = v_registration.id;
    return jsonb_build_object(
      'status', case
        when v_registration.attempt_failures + 1 >= p_max_failures then 'locked'
        else 'wrong_code'
      end,
      'registration_id', v_registration.id,
      'remaining', greatest(p_max_failures - v_registration.attempt_failures - 1, 0)
    );
  end if;

  -- Serialize this user's claims so the cap below holds.
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select count(*) filter (where revoked_at is null), count(*)
    into v_connected, v_ever
    from public.agent_registrations
   where user_id = p_user_id
     and claimed_at is not null;

  if v_connected >= p_max_agents then
    return jsonb_build_object('status', 'too_many_agents', 'registration_id', v_registration.id);
  end if;

  update public.agent_registrations
     set user_id = p_user_id,
         claimed_at = now(),
         attempt_token_hash = null,
         attempt_user_code_hash = null
   where id = v_registration.id;

  -- Adopt the live sandbox endpoints, oldest first, up to the cap. They keep
  -- their slugs and captures; 00053's trigger gives the requests the owner.
  with picked as (
    select id
      from public.endpoints
     where agent_registration_id = v_registration.id
       and expires_at > now()
     order by created_at
     limit p_max_adopt
  ),
  adopted as (
    update public.endpoints e
       set user_id = p_user_id,
           is_ephemeral = false,
           expires_at = null,
           agent_registration_id = null
      from picked
     where e.id = picked.id
    returning e.slug
  )
  select coalesce(array_agg(slug order by slug), '{}') into v_adopted from adopted;

  -- Whatever was not adopted goes now rather than waiting for cleanup.
  delete from public.endpoints where agent_registration_id = v_registration.id;
  -- Pre-claim tokens stop working: only the claim token holder gets
  -- account credentials, through the claim grant.
  delete from public.api_keys
   where agent_registration_id = v_registration.id
     and user_id is null;

  return jsonb_build_object(
    'status', 'ok',
    'registration_id', v_registration.id,
    'kind', v_registration.kind,
    'client_name', v_registration.client_name,
    'adopted', to_jsonb(v_adopted),
    'first_agent', v_ever = 0
  );
end;
$$;

revoke all on function public.complete_agent_claim(text, text, uuid, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.complete_agent_claim(text, text, uuid, text, integer, integer, integer)
  to service_role;

-- 3. The named human refuses the attempt.
create or replace function public.deny_agent_claim_attempt(
  p_attempt_token_hash text,
  p_user_email         text
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration public.agent_registrations%rowtype;
begin
  select * into v_registration
    from public.agent_registrations
   where attempt_token_hash = p_attempt_token_hash
     for update;

  if not found or v_registration.revoked_at is not null or v_registration.claimed_at is not null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if lower(coalesce(p_user_email, '')) is distinct from v_registration.attempt_login_hint then
    return jsonb_build_object('status', 'wrong_account', 'registration_id', v_registration.id);
  end if;

  update public.agent_registrations
     set attempt_denied_at = coalesce(attempt_denied_at, now())
   where id = v_registration.id;

  return jsonb_build_object('status', 'ok', 'registration_id', v_registration.id);
end;
$$;

revoke all on function public.deny_agent_claim_attempt(text, text)
  from public, anon, authenticated;
grant execute on function public.deny_agent_claim_attempt(text, text) to service_role;

-- 4. A user disconnects one of their agents. The row stays 7 days for the
-- record (cleanup_expired_agent_registrations deletes it then).
create or replace function public.revoke_agent_registration(p_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.agent_registrations
     set revoked_at = now()
   where id = p_id
     and user_id = p_user_id
     and revoked_at is null;

  if not found then
    return false;
  end if;

  delete from public.api_keys where agent_registration_id = p_id;
  return true;
end;
$$;

revoke all on function public.revoke_agent_registration(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_agent_registration(uuid, uuid) to service_role;

-- 5. claim_device_code() from 00033, counting and rotating only keys that
-- are not agent tokens.
create or replace function public.claim_device_code(
  p_device_code text,
  p_key_hash text,
  p_key_prefix text,
  p_key_name text,
  p_key_expires_at timestamptz,
  p_max_keys integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code public.device_codes%rowtype;
  v_email text;
  v_key_count integer;
  v_excess integer;
  v_rotatable integer;
begin
  select * into v_code
  from public.device_codes
  where device_code = p_device_code
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_code.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_code.status <> 'authorized' or v_code.user_id is null then
    return jsonb_build_object('status', 'not_authorized');
  end if;

  -- Serialize concurrent claims per user (same pattern as accept_team_invite):
  -- the cap check below is only correct while no other claim can interleave.
  select email into v_email
  from public.users
  where id = v_code.user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select count(*) into v_key_count
  from public.api_keys
  where user_id = v_code.user_id
    and agent_registration_id is null;

  if v_key_count >= p_max_keys then
    v_excess := v_key_count - p_max_keys + 1;

    select count(*) into v_rotatable
    from public.api_keys
    where user_id = v_code.user_id
      and is_device_auth;

    -- Checked before deleting anything: a plain `return` still commits prior
    -- statements, so the key_limit path must not have rotated any keys.
    if v_rotatable < v_excess then
      return jsonb_build_object('status', 'key_limit');
    end if;

    delete from public.api_keys
    where id in (
      select id
      from public.api_keys
      where user_id = v_code.user_id
        and is_device_auth
      order by created_at asc
      limit v_excess
    );
  end if;

  delete from public.device_codes where id = v_code.id;

  insert into public.api_keys (user_id, key_hash, key_prefix, name, expires_at, is_device_auth)
  values (v_code.user_id, p_key_hash, p_key_prefix, p_key_name, p_key_expires_at, true);

  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_code.user_id,
    'email', v_email
  );
end;
$$;

revoke all on function public.claim_device_code(text, text, text, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.claim_device_code(text, text, text, text, timestamptz, integer)
  to service_role;

commit;

notify pgrst, 'reload schema';
