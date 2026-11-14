-- Drop the unbounded search functions that search_requests_page() (migration
-- 00100) replaced. Nothing calls them since web 0.72.0: the routes, the
-- dashboard and every client go through the bounded function. Dropping them
-- also removes a way to start a search that reads an endpoint's whole
-- retained range with no time budget.

drop function if exists public.search_requests(uuid, text, text, text, text, bigint, bigint, integer, integer, text, text);
drop function if exists public.search_requests_count(uuid, text, text, text, text, bigint, bigint, text);
