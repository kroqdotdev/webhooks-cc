-- The device login's approval page shows the country only: a city from IP
-- geolocation is too imprecise to help anyone tell their own login from
-- someone else's, and getting one would have meant a Cloudflare rule of its
-- own. Nothing writes or reads device_codes.city since the release that
-- dropped it; apply this after deploying that release.

alter table public.device_codes drop column if exists city;
