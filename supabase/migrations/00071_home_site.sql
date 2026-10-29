-- 00071: the site an account uses (webhooks.cc or mailhooks.cc), so emails
-- sent outside a request (quota, alerts) link where its session is.
-- Sessions are per host. Set by the web app's sign-in routes to the site
-- the person last signed in on. Re-runnable.

alter table public.users
  add column if not exists home_site text not null default 'webhooks';

-- Added unchecked and validated after, so the scan of users does not hold
-- the table's exclusive lock.
alter table public.users drop constraint if exists users_home_site_check;
alter table public.users
  add constraint users_home_site_check check (home_site in ('webhooks', 'mailhooks')) not valid;
alter table public.users validate constraint users_home_site_check;

notify pgrst, 'reload schema';
