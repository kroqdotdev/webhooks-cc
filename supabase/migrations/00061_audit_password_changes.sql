-- ============================================================================
-- Migration 00061: record password changes in audit_events
--
-- Password changes go from the browser straight to GoTrue (the password panel
-- on /account, /auth/reset-password), so no route of ours sees them and
-- auditUserAction() never runs. GoTrue's own audit log has them, but it holds
-- the account's email and is pruned with everything else in it (00047).
--
-- A trigger on auth.users records every change of encrypted_password,
-- whichever path made it: one audit_events row with action
-- 'account.password_changed', the account as actor, and
-- metadata.first_password when the account had no password before (a GitHub
-- or Google account setting one through a reset link; accounts created by
-- agent registration already hold a random one). GoTrue only changes a
-- password for the signed-in account or for the service role, which this app
-- never uses for it, so the account is the actor; how it signed in is unknown
-- here, so via stays null.
--
-- The WHEN clause keeps the trigger to real changes of the hash: the
-- last_sign_in_at and similar updates GoTrue makes on every sign-in skip it.
-- Recording never blocks the change: a failed insert raises a warning and the
-- update goes ahead, as auditUserAction() never fails a request.
--
-- security definer: GoTrue's role has no privileges on public.audit_events.
-- Trigger execution does not check EXECUTE (see 00037), so revoking it from
-- the client roles costs GoTrue nothing.
-- ============================================================================

create or replace function public.audit_password_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.audit_events (actor_type, actor_user_id, action, metadata)
    values (
      'user',
      new.id,
      'account.password_changed',
      case
        when coalesce(old.encrypted_password, '') = '' then jsonb_build_object('first_password', true)
        else '{}'::jsonb
      end
    );
  exception when others then
    raise warning 'audit_password_change: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

revoke all on function public.audit_password_change() from public, anon, authenticated;

create or replace trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.audit_password_change();
