-- 00082: the analytics choice from the cookie banner, kept on the account so
-- it follows a signed-in person to their other browsers. The browser keeps its
-- own copy (posthog-js, localStorage); this one only answers the banner
-- elsewhere: a decline applies to every browser the account signs in on, an
-- accept only to a browser that has not answered yet. Written only by the
-- session route /api/account/analytics-consent with the service role (client
-- roles have no write access to users). Re-runnable.

-- Nullable without a default: a catalog-only change, no table rewrite.
alter table public.users
  add column if not exists analytics_consent text,
  add column if not exists analytics_consent_at timestamptz;

-- Every existing row is null, so validating right away scans without finding
-- a violation; NOT VALID first keeps the exclusive lock to the catalog change.
alter table public.users drop constraint if exists users_analytics_consent_check;
alter table public.users
  add constraint users_analytics_consent_check
  check (analytics_consent in ('granted', 'denied')) not valid;
alter table public.users validate constraint users_analytics_consent_check;

comment on column public.users.analytics_consent is
  'The cookie banner choice saved from a signed-in browser: granted or denied, null until one is saved.';
comment on column public.users.analytics_consent_at is
  'When analytics_consent was last saved.';
