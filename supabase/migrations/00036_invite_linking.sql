-- ============================================================================
-- Migration 00036: Team invite linking + pending-checkout cache
--
-- 1. handle_new_user(): after the users upsert, claim any pending invites
--    addressed to the new account's email. createInvite lowercases
--    invited_email at write time, so a lower() comparison on the auth email
--    is exact. The trigger also fires on auth.users email UPDATEs (OAuth
--    re-login, future email change), which is desirable: a changed email
--    picks up invites addressed to the new address.
--
-- 2. teams.pending_checkout: cache of the most recent Polar checkout session
--    ({"id","url","seats","created_at"}), letting createTeamCheckout return
--    the same session instead of minting doubles. Nulled whenever a
--    subscription event applies.
--
-- NOTE: no revoke/grant on handle_new_user: it runs as an auth.users
-- trigger under supabase_auth_admin, and the original 00001 definition
-- carries no ACL statements on purpose. Do not "harden" it.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.users (id, email, name, image)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do update set
    email = excluded.email,
    name  = coalesce(excluded.name, public.users.name),
    image = coalesce(excluded.image, public.users.image);

  -- Link pending team invites addressed to this email to the account.
  update public.team_invites
  set invited_user_id = new.id
  where lower(invited_email) = lower(new.email)
    and invited_user_id is null
    and status = 'pending';

  return new;
end;
$$;

alter table public.teams add column pending_checkout jsonb;

notify pgrst, 'reload schema';
