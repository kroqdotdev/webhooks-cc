-- What the approval page shows about a `whk auth login` (and any other
-- device login) before the person approves it: which client asked, from
-- which country (and city, when the edge sends one), from which network,
-- and whether the login said it runs on another machine (`--remote`).
-- The person compares the code rather than typing it, so these are what
-- tell a login they started apart from one someone sent them.
--
-- network is the requester's /24 (IPv4) or /48 (IPv6), never the address,
-- and every column goes with the row: cleanup_expired_device_codes() deletes
-- rows 15 minutes after they were made, and a claim deletes its row.
--
-- A person can now refuse a login ("This wasn't me"), which ends it at once
-- instead of leaving it to expire: status 'denied'.

alter table public.device_codes
  add column if not exists client text check (char_length(client) <= 120),
  add column if not exists country text check (char_length(country) <= 2),
  add column if not exists city text check (char_length(city) <= 80),
  add column if not exists network text check (char_length(network) <= 64),
  add column if not exists remote boolean not null default false;

-- The table holds at most a few hundred rows (codes live 15 minutes), so the
-- constraint is replaced and checked in one step.
alter table public.device_codes
  drop constraint if exists device_codes_status_check;
alter table public.device_codes
  add constraint device_codes_status_check
  check (status in ('pending', 'authorized', 'denied'));
