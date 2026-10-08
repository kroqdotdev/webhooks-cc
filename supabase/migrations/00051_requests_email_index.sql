-- 00051: an index for reading an endpoint's emails.
--
-- The request list routes take `kind=email` (the SDK's emails.waitFor polls
-- with it, and forwarding's test delivery reads the newest email). With only
-- requests_endpoint_time, Postgres walks an endpoint's HTTP history to find
-- its few emails. Partial on kind = 'email', so HTTP captures never write to
-- it and capture throughput is unchanged (the same reasoning as
-- requests_endpoint_dedupe in 00048).
--
-- CONCURRENTLY cannot run inside a transaction: apply this file in autocommit
-- mode, as AGENTS.md shows.

create index concurrently if not exists requests_endpoint_email_time
  on public.requests (endpoint_id, received_at desc)
  where kind = 'email';
