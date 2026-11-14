-- 00105: ID-JAG issuers a team trusts (organisation identity assertions).
--
-- Some organisations' AI platforms issue ID-JAG identity assertions
-- (draft-ietf-oauth-identity-assertion-authz-grant) for their members, under
-- an issuer URL of the organisation's own. A team's owner can trust such an
-- issuer, so a member's agent connects with the member's assertion at the
-- token endpoint (the jwt-bearer grant) instead of a sign-in each time. The
-- web app decides which issuers may be added at all
-- (AGENT_IDJAG_ORG_ISSUER_PREFIXES, empty in production: the feature is off).
--
-- 1. team_idjag_issuers: one row per (team, issuer), with the client ids the
--    issuer may name (empty: any), who added it and when. No client access.
-- 2. agent_registrations.idjag_team_issuer_id: the trust row a delegation was
--    made through, so removing the row, or the member leaving the team,
--    revokes exactly the delegations it made.
-- 3. link_team_idjag_identity(): resolves an assertion to a member of a team
--    that trusts its issuer, by the verified email, and then follows
--    link_agent_idjag_identity() (00057): a delegation on file links at once;
--    otherwise the member confirms through the claim ceremony first. It never
--    creates an account and never binds silently.
-- 4. add_team_idjag_issuer() and remove_team_idjag_issuer(): owner only.
-- 5. Triggers revoke the delegations (and delete their tokens) when a trust
--    row goes, whatever deleted it (the owner, the team's deletion), and when
--    a member leaves or is removed; every revocation is written to
--    audit_events.
--
-- Service role only. Apply in autocommit mode (see AGENTS.md): the index on
-- agent_registrations is built concurrently, outside the transaction.

begin;

-- 1. The trusted issuers.
create table public.team_idjag_issuers (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams(id) on delete cascade,
  issuer             text not null
                       check (char_length(issuer) between 12 and 512 and issuer like 'https://%'),
  -- The client ids an assertion from this issuer may name; empty means any.
  allowed_client_ids text[] not null default '{}'
                       check (cardinality(allowed_client_ids) <= 10),
  added_by           uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint team_idjag_issuers_team_issuer unique (team_id, issuer)
);

-- Every assertion looks its issuer up.
create index team_idjag_issuers_issuer on public.team_idjag_issuers (issuer);
-- The cascade when the adding user is deleted.
create index team_idjag_issuers_added_by
  on public.team_idjag_issuers (added_by)
  where added_by is not null;

alter table public.team_idjag_issuers enable row level security;
revoke all on table public.team_idjag_issuers from public, anon, authenticated;

-- 2. The trust row a delegation came through. A nullable column without a
-- default is a catalog-only change. The BEFORE DELETE trigger below revokes
-- before the foreign key's SET NULL runs.
alter table public.agent_registrations
  add column if not exists idjag_team_issuer_id uuid
    references public.team_idjag_issuers(id) on delete set null;

-- Revokes registrations made through the given trust rows: all of them, or
-- only one member's (claimed as that user, or still waiting for that email).
-- Deletes their tokens and records each revocation. Returns the ids.
create or replace function public.revoke_team_idjag_delegations(
  p_trust_ids uuid[],
  p_user_id   uuid,
  p_team_id   uuid,
  p_source    text
)
returns uuid[]
language plpgsql
security definer set search_path = ''
as $$
declare
  v_email text;
  v_ids   uuid[];
begin
  if p_user_id is not null then
    select lower(email) into v_email from public.users where id = p_user_id;
  end if;

  with revoked as (
    update public.agent_registrations r
       set revoked_at = now()
     where r.idjag_team_issuer_id = any(p_trust_ids)
       and r.revoked_at is null
       and (
         p_user_id is null
         or r.user_id = p_user_id
         or (r.claimed_at is null and v_email is not null and r.attempt_login_hint = v_email)
       )
    returning r.id, r.kind, r.user_id, r.idjag_iss
  ),
  tokens as (
    delete from public.api_keys
     where agent_registration_id in (select id from revoked)
    returning 1
  ),
  audited as (
    insert into public.audit_events (
      actor_type, action, outcome, team_id, target_id, target_user_id, metadata
    )
    select 'system', 'agent.registration.revoked', 'ok', p_team_id, r.id::text,
           coalesce(r.user_id, p_user_id),
           jsonb_build_object('kind', r.kind, 'source', p_source, 'issuer', left(r.idjag_iss, 200))
      from revoked r
    returning 1
  )
  select coalesce(array_agg(id), '{}') into v_ids from revoked;

  return v_ids;
end;
$$;

revoke all on function public.revoke_team_idjag_delegations(uuid[], uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_team_idjag_delegations(uuid[], uuid, uuid, text)
  to service_role;

-- 3. Resolve an organisation ID-JAG to a team member and link it.
create or replace function public.link_team_idjag_identity(
  p_iss                text,
  p_sub                text,
  p_email              text,
  p_client_id          text,
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
  v_user_id      uuid;
  v_trust_ids    uuid[];
  v_trust_id     uuid;
  v_team_id      uuid;
  v_registration public.agent_registrations%rowtype;
  v_result       jsonb;
begin
  -- Exact match: emails are stored lower-cased.
  select id into v_user_id from public.users where email = p_email;
  if v_user_id is null then
    return jsonb_build_object('status', 'not_member');
  end if;

  -- The same lock as link_agent_idjag_identity(), taken first so the checks
  -- below and its decision see one state.
  perform pg_advisory_xact_lock(hashtextextended('agent-idjag:' || p_iss || '#' || p_sub, 0));

  -- Trust rows of teams this person belongs to, oldest first.
  select array_agg(t.id order by t.created_at, t.id) into v_trust_ids
    from public.team_idjag_issuers t
    join public.team_members m on m.team_id = t.team_id and m.user_id = v_user_id
   where t.issuer = p_iss
     and (cardinality(t.allowed_client_ids) = 0 or p_client_id = any(t.allowed_client_ids));

  if v_trust_ids is null then
    if exists (
      select 1
        from public.team_idjag_issuers t
        join public.team_members m on m.team_id = t.team_id and m.user_id = v_user_id
       where t.issuer = p_iss
    ) then
      return jsonb_build_object('status', 'client_not_allowed');
    end if;
    return jsonb_build_object('status', 'not_member');
  end if;

  select * into v_registration
    from public.agent_registrations
   where idjag_iss = p_iss
     and idjag_sub = p_sub
     and revoked_at is null
     for update;

  if found and v_registration.claimed_at is not null then
    -- A delegation on file links only for the member it was made for, and
    -- only while it came through a trust row that still covers them.
    if v_registration.user_id is distinct from v_user_id
       or v_registration.idjag_team_issuer_id is null
       or not (v_registration.idjag_team_issuer_id = any(v_trust_ids)) then
      return jsonb_build_object('status', 'identity_mismatch');
    end if;
    select team_id into v_team_id
      from public.team_idjag_issuers where id = v_registration.idjag_team_issuer_id;
    return jsonb_build_object(
      'status', 'linked',
      'registration_id', v_registration.id,
      'user_id', v_registration.user_id,
      'team_id', v_team_id,
      'created', false
    );
  end if;

  -- No delegation yet: the member confirms through the claim ceremony. Never
  -- a new account (p_jit_user_id null).
  v_result := public.link_agent_idjag_identity(
    p_iss, p_sub, p_email, null,
    p_claim_token_hash, p_attempt_token_hash, p_user_code_hash,
    p_lifetime_seconds, p_attempt_seconds, p_max_attempts, p_max_pending
  );

  if v_result->>'status' = 'pending' then
    -- Keep the trust row this ceremony started through; a re-issued
    -- ceremony keeps the one it has while that still covers the member.
    select idjag_team_issuer_id into v_trust_id
      from public.agent_registrations
     where id = (v_result->>'registration_id')::uuid;
    if v_trust_id is null or not (v_trust_id = any(v_trust_ids)) then
      v_trust_id := v_trust_ids[1];
      update public.agent_registrations
         set idjag_team_issuer_id = v_trust_id
       where id = (v_result->>'registration_id')::uuid;
    end if;
    select team_id into v_team_id from public.team_idjag_issuers where id = v_trust_id;
    v_result := v_result || jsonb_build_object('team_id', v_team_id);
  end if;

  return v_result;
end;
$$;

revoke all on function public.link_team_idjag_identity(
  text, text, text, text, text, text, text, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.link_team_idjag_identity(
  text, text, text, text, text, text, text, integer, integer, integer, integer
) to service_role;

-- 4. Owner-only changes. The team row is locked so the cap holds.
create or replace function public.add_team_idjag_issuer(
  p_team_id    uuid,
  p_user_id    uuid,
  p_issuer     text,
  p_client_ids text[],
  p_max        integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row public.team_idjag_issuers%rowtype;
begin
  perform 1 from public.teams where id = p_team_id for update;
  if not found then
    return jsonb_build_object('status', 'not_owner');
  end if;
  if not exists (
    select 1 from public.team_members
     where team_id = p_team_id and user_id = p_user_id and role = 'owner'
  ) then
    return jsonb_build_object('status', 'not_owner');
  end if;
  if exists (
    select 1 from public.team_idjag_issuers where team_id = p_team_id and issuer = p_issuer
  ) then
    return jsonb_build_object('status', 'exists');
  end if;
  if (select count(*) from public.team_idjag_issuers where team_id = p_team_id) >= p_max then
    return jsonb_build_object('status', 'limit');
  end if;

  insert into public.team_idjag_issuers (team_id, issuer, allowed_client_ids, added_by)
  values (p_team_id, p_issuer, coalesce(p_client_ids, '{}'), p_user_id)
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'id', v_row.id, 'created_at', v_row.created_at);
end;
$$;

revoke all on function public.add_team_idjag_issuer(uuid, uuid, text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.add_team_idjag_issuer(uuid, uuid, text, text[], integer)
  to service_role;

create or replace function public.remove_team_idjag_issuer(
  p_team_id   uuid,
  p_user_id   uuid,
  p_issuer_id uuid
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_issuer  text;
  v_revoked uuid[];
begin
  if not exists (
    select 1 from public.team_members
     where team_id = p_team_id and user_id = p_user_id and role = 'owner'
  ) then
    return jsonb_build_object('status', 'not_owner');
  end if;

  select issuer into v_issuer
    from public.team_idjag_issuers
   where id = p_issuer_id and team_id = p_team_id
     for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Revoked here to report them; the trigger then finds nothing left.
  v_revoked := public.revoke_team_idjag_delegations(
    array[p_issuer_id], null, p_team_id, 'team_issuer_removed'
  );
  delete from public.team_idjag_issuers where id = p_issuer_id;

  return jsonb_build_object(
    'status', 'ok',
    'issuer', v_issuer,
    'revoked', to_jsonb(v_revoked)
  );
end;
$$;

revoke all on function public.remove_team_idjag_issuer(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_team_idjag_issuer(uuid, uuid, uuid) to service_role;

-- 5. Revocation, whatever removed the trust or the membership.
create or replace function public.team_idjag_issuers_before_delete()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  perform public.revoke_team_idjag_delegations(
    array[old.id], null, old.team_id, 'team_issuer_removed'
  );
  return old;
end;
$$;

revoke all on function public.team_idjag_issuers_before_delete()
  from public, anon, authenticated;

create trigger team_idjag_issuers_revoke
  before delete on public.team_idjag_issuers
  for each row execute function public.team_idjag_issuers_before_delete();

create or replace function public.team_members_revoke_idjag()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_trust_ids uuid[];
begin
  select array_agg(id) into v_trust_ids
    from public.team_idjag_issuers
   where team_id = old.team_id;
  if v_trust_ids is not null then
    perform public.revoke_team_idjag_delegations(
      v_trust_ids, old.user_id, old.team_id, 'team_member_left'
    );
  end if;
  return null;
end;
$$;

revoke all on function public.team_members_revoke_idjag()
  from public, anon, authenticated;

create trigger team_members_revoke_idjag
  after delete on public.team_members
  for each row execute function public.team_members_revoke_idjag();

commit;

-- The revocations above look registrations up by trust row.
create index concurrently if not exists agent_registrations_idjag_team_issuer
  on public.agent_registrations (idjag_team_issuer_id)
  where idjag_team_issuer_id is not null;

notify pgrst, 'reload schema';
