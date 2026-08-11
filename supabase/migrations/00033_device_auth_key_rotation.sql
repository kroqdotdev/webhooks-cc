-- ============================================================================
-- 00033: Device-auth key provenance + atomic claim
-- ============================================================================
-- 1. api_keys.is_device_auth — provenance flag for keys minted by the CLI
--    device flow. Rotation eligibility must not depend on the display name:
--    /api/api-keys accepts arbitrary names, so a manually created key named
--    "CLI (device auth)" would otherwise be classified as rotatable.
-- 2. claim_device_code() — the whole claim (cap check, device-auth key
--    rotation, code consumption, key insert) in one transaction, serialized
--    per user via the users row lock. As separate service-role statements,
--    concurrent claims could exceed the key cap, and a failure mid-sequence
--    could revoke a rotated key or consume the code without minting the
--    replacement key.
-- ============================================================================

alter table public.api_keys
  add column if not exists is_device_auth boolean not null default false;

-- Backfill: the display name is the only provenance signal for existing rows.
update public.api_keys
set is_device_auth = true
where name = 'CLI (device auth)'
  and not is_agent_issued;

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
  where user_id = v_code.user_id;

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
