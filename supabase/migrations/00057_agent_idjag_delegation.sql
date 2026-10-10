-- 00057: ID-JAG delegations and provider revocation (auth.md v0.5 and v0.6).
--
-- An identity_assertion registration is the delegation for one provider
-- identity (iss, sub). Before any provider is trusted, binding one to an
-- account must follow the spec:
--
-- 1. link_agent_idjag_identity(): one call per presented ID-JAG, serialized
--    per (iss, sub). A delegation already on file links at once. A provider
--    identity whose verified email belongs to an existing account never binds
--    silently: it gets a pending registration with a claim attempt, and the
--    human signed in as that email confirms it through the claim ceremony
--    (the step-up auth.md v0.5 added). Presenting the identity again while it
--    waits re-issues the ceremony with a new claim token. Only an account the
--    caller has just created for the email links without a ceremony.
-- 2. start_agent_claim_attempt(): an identity_assertion registration keeps
--    the email its assertion carried, like service_auth.
-- 3. revoke_agent_delegation(): a provider's Security Event Token revokes
--    every registration of (iss, sub) and deletes their tokens. The next
--    ID-JAG for that identity starts over, with a ceremony for an existing
--    account.
-- 4. agent_idjag_jti remembers Security Event Token ids as purpose 'set'.
--
-- Service role only. Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. Link a provider identity, or start (or re-issue) its step-up ceremony.
create or replace function public.link_agent_idjag_identity(
  p_iss                text,
  p_sub                text,
  p_login_hint         text,
  p_jit_user_id        uuid,
  p_claim_token_hash   text,
  p_attempt_token_hash text,
  p_user_code_hash     text,
  p_lifetime_seconds   integer,
  p_attempt_seconds    integer,
  p_max_attempts       integer,
  p_max_pending        integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_registration public.agent_registrations%rowtype;
  v_live         boolean;
  v_pending      integer;
  v_expires      timestamptz;
  v_attempt      timestamptz;
begin
  -- One presentation of an identity at a time, so the checks below and the
  -- partial unique index on (idjag_iss, idjag_sub) never race.
  perform pg_advisory_xact_lock(hashtextextended('agent-idjag:' || p_iss || '#' || p_sub, 0));

  select * into v_registration
    from public.agent_registrations
   where idjag_iss = p_iss
     and idjag_sub = p_sub
     and revoked_at is null
     for update;
  v_live := found;

  if v_live and v_registration.claimed_at is not null then
    return jsonb_build_object(
      'status', 'linked',
      'registration_id', v_registration.id,
      'user_id', v_registration.user_id,
      'created', false
    );
  end if;

  -- A step-up that expired, names another email, or whose account is gone
  -- (the caller just created one) holds nothing: no tokens, no endpoints.
  if v_live and (
       v_registration.expires_at <= now()
       or v_registration.attempt_login_hint is distinct from p_login_hint
       or p_jit_user_id is not null
     ) then
    delete from public.agent_registrations where id = v_registration.id;
    v_live := false;
  end if;

  -- The caller created this account for the assertion's email just now, so
  -- there is nobody else's account to protect.
  if p_jit_user_id is not null then
    insert into public.agent_registrations (
      kind, user_id, claimed_at, expires_at, idjag_iss, idjag_sub
    ) values (
      -- A registration claimed from the start has no unclaimed lifetime.
      'identity_assertion', p_jit_user_id, now(), now(), p_iss, p_sub
    )
    returning * into v_registration;

    return jsonb_build_object(
      'status', 'linked',
      'registration_id', v_registration.id,
      'user_id', v_registration.user_id,
      'created', true
    );
  end if;

  if v_live then
    if v_registration.attempts_issued >= p_max_attempts then
      return jsonb_build_object('status', 'too_many_attempts', 'registration_id', v_registration.id);
    end if;
    v_attempt := least(now() + make_interval(secs => p_attempt_seconds), v_registration.expires_at);

    -- A new claim token too: the agent presenting the identity again may
    -- have lost the earlier one, and only its hash is stored.
    update public.agent_registrations
       set claim_token_hash       = p_claim_token_hash,
           attempt_token_hash     = p_attempt_token_hash,
           attempt_user_code_hash = p_user_code_hash,
           attempt_expires_at     = v_attempt,
           attempt_failures       = 0,
           attempt_denied_at      = null,
           attempts_issued        = attempts_issued + 1
     where id = v_registration.id;

    return jsonb_build_object(
      'status', 'pending',
      'registration_id', v_registration.id,
      'created', false,
      'attempt', v_registration.attempts_issued + 1,
      'attempt_expires_at', v_attempt,
      'expires_at', v_registration.expires_at
    );
  end if;

  -- A new step-up. Agents waiting for one person are capped together,
  -- whichever way they registered.
  select count(*) into v_pending
    from public.agent_registrations
   where kind in ('service_auth', 'identity_assertion')
     and attempt_login_hint = p_login_hint
     and claimed_at is null
     and revoked_at is null
     and expires_at > now();
  if v_pending >= p_max_pending then
    return jsonb_build_object('status', 'too_many_pending');
  end if;

  v_expires := now() + make_interval(secs => p_lifetime_seconds);
  v_attempt := least(now() + make_interval(secs => p_attempt_seconds), v_expires);

  insert into public.agent_registrations (
    kind, claim_token_hash, expires_at,
    attempt_token_hash, attempt_user_code_hash, attempt_login_hint, attempt_expires_at,
    attempts_issued, idjag_iss, idjag_sub
  ) values (
    'identity_assertion', p_claim_token_hash, v_expires,
    p_attempt_token_hash, p_user_code_hash, p_login_hint, v_attempt,
    1, p_iss, p_sub
  )
  returning * into v_registration;

  return jsonb_build_object(
    'status', 'pending',
    'registration_id', v_registration.id,
    'created', true,
    'attempt', 1,
    'attempt_expires_at', v_attempt,
    'expires_at', v_expires
  );
end;
$$;

revoke all on function public.link_agent_idjag_identity(
  text, text, text, uuid, text, text, text, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.link_agent_idjag_identity(
  text, text, text, uuid, text, text, text, integer, integer, integer, integer
) to service_role;

-- 2. start_agent_claim_attempt() from 00056: identity_assertion
-- registrations are bound to their email like service_auth ones.
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
  -- service_auth is bound to the email it registered with, identity_assertion
  -- to the verified email of its assertion; an anonymous registration names
  -- one with each attempt.
  if v_registration.kind in ('service_auth', 'identity_assertion') then
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

-- 3. A provider revoked (iss, sub): the registration and its delegation go,
-- with every token derived from it. Returns the revoked registration ids.
create or replace function public.revoke_agent_delegation(p_iss text, p_sub text)
returns uuid[]
language plpgsql
security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with revoked as (
    update public.agent_registrations
       set revoked_at = now()
     where idjag_iss = p_iss
       and idjag_sub = p_sub
       and revoked_at is null
    returning id, kind, user_id
  ),
  tokens as (
    delete from public.api_keys
     where agent_registration_id in (select id from revoked)
    returning 1
  ),
  audited as (
    insert into public.audit_events (
      actor_type, action, outcome, target_id, target_user_id, metadata
    )
    select 'system', 'agent.registration.revoked', 'ok', r.id::text, r.user_id,
           jsonb_build_object('kind', r.kind, 'source', 'security_event', 'issuer', p_iss)
      from revoked r
    returning 1
  )
  select coalesce(array_agg(id), '{}') into v_ids from revoked;

  return v_ids;
end;
$$;

revoke all on function public.revoke_agent_delegation(text, text)
  from public, anon, authenticated;
grant execute on function public.revoke_agent_delegation(text, text) to service_role;

-- 4. Security Event Token ids share the replay table with ID-JAG ids.
alter table public.agent_idjag_jti drop constraint agent_idjag_jti_purpose_check;
alter table public.agent_idjag_jti
  add constraint agent_idjag_jti_purpose_check
  check (purpose in ('id-jag', 'logout', 'set')) not valid;

commit;

alter table public.agent_idjag_jti validate constraint agent_idjag_jti_purpose_check;

notify pgrst, 'reload schema';
