-- 00052: no new accounts at the capture domain.
--
-- Mail to {slug}[+tag]@mailhooks.cc lands on an endpoint and can be read
-- through webhooks.cc itself, so an address there proves nothing about who
-- holds it: with one endpoint, anyone could confirm any number of accounts
-- (one per +tag), by email and password or through a GitHub or Google
-- account whose address they verified the same way. Agent registration
-- already refuses these addresses in the app (web 0.35.3).
--
-- GoTrue calls this function before it creates a user through signup,
-- OAuth, magic link or OTP, invite (including the admin invite and
-- generate_link endpoints) and anonymous sign-in. Admin createUser does not
-- call it; agent registration, its only user here, checks in the app.
-- Existing users and email changes are not affected.
--
-- Turned on in the auth container with
--   GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true"
--   GOTRUE_HOOK_BEFORE_USER_CREATED_URI: pg-functions://postgres/public/hook_before_user_created
-- Apply this file before turning the hook on: while the function is missing,
-- GoTrue fails every signup. See infra/supabase/gotrue-email-auth.md.
--
-- The domain is written out here; the app reads it from EMAIL_CAPTURE_DOMAIN,
-- whose default is the same.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  email_domain text;
begin
  email_domain := rtrim(
    substring(lower(btrim(coalesce(event #>> '{user,email}', ''))) from '@([^@]*)$'),
    '.'
  );
  if email_domain = 'mailhooks.cc' or email_domain like '%.mailhooks.cc' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Addresses at mailhooks.cc cannot be used for an account. Sign up with your own email address.'
      )
    );
  end if;
  return '{}'::jsonb;
end;
$$;

comment on function public.hook_before_user_created(jsonb) is
  'GoTrue before-user-created hook: refuses accounts at the capture domain (00052).';

-- Only GoTrue calls it.
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
