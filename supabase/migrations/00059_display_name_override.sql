-- ============================================================================
-- 00059: user-edited display name survives OAuth re-login
-- ============================================================================
-- PATCH /api/account stores a user's chosen name as `display_name` in the auth
-- user's app_metadata and writes public.users.name directly. app_metadata,
-- unlike user_metadata, can only be written with the service role, so the
-- route's checks (length, control and bidi characters) cannot be skipped by
-- calling GoTrue's updateUser from the browser.
--
-- handle_new_user() runs on insert and on every `update of email,
-- raw_user_meta_data` of auth.users (an OAuth re-login refreshes the
-- provider's keys), and until now copied the provider's full_name/name. It now
-- prefers the override, skips blank names, and cleans whichever name it picks
-- the same way the route does: control, line-separator and bidi characters
-- removed, spaces trimmed, at most 80 characters. user_metadata is user-writable, so the provider names
-- need the cleaning too. lib/supabase/profile.ts mirrors this; change them
-- together.
--
-- The trigger itself is unchanged: an override change always goes through the
-- route, which writes public.users.name itself.
--
-- NOTE: no revoke/grant on handle_new_user: it runs as an auth.users trigger
-- under supabase_auth_admin, and CREATE OR REPLACE keeps the existing ACL.
-- Do not "harden" it.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  chosen_name text;
begin
  chosen_name := nullif(
    left(
      btrim(
        regexp_replace(
          coalesce(
            nullif(btrim(new.raw_app_meta_data ->> 'display_name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'name'), '')
          ),
          '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]',
          '',
          'g'
        )
      ),
      80
    ),
    ''
  );

  insert into public.users (id, email, name, image)
  values (
    new.id,
    new.email,
    chosen_name,
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

notify pgrst, 'reload schema';
