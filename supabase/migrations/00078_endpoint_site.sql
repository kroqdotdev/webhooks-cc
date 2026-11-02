-- 00078: which site's dashboard lists an endpoint (webhooks.cc, mailhooks.cc
-- or both). Only the listing: every endpoint keeps its HTTP URL and its
-- email address and captures both, whatever it says here. The dashboard
-- sets the site it creates an endpoint on; existing endpoints and those made
-- through the API without one are listed on both. Re-runnable.

-- A constant default: no table rewrite.
alter table public.endpoints
  add column if not exists site text not null default 'both';

-- Added unchecked and validated after, so the scan of endpoints does not
-- hold the table's exclusive lock.
alter table public.endpoints drop constraint if exists endpoints_site_check;
alter table public.endpoints
  add constraint endpoints_site_check check (site in ('webhooks', 'mailhooks', 'both')) not valid;
alter table public.endpoints validate constraint endpoints_site_check;

comment on column public.endpoints.site is
  'Which site''s dashboard lists the endpoint: webhooks, mailhooks or both. Listing only; capture is the same either way.';
