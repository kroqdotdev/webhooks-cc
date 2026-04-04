-- ============================================================================
-- Companion script for migration 00020: Create trigram search indexes
--
-- These indexes accelerate the ILIKE '%...%' patterns used by
-- search_requests() and search_requests_count() in 00004_request_search.sql.
--
-- MUST be run outside a transaction (CREATE INDEX CONCURRENTLY cannot run
-- inside one). Run manually via psql:
--
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/create_search_indexes.sql
--
-- The indexes are created CONCURRENTLY so they do not block writes.
-- Expected creation time depends on table size (minutes for large tables).
-- ============================================================================

set statement_timeout = 0;
set lock_timeout = 0;

-- Trigram index on request path (short, high selectivity)
create index concurrently if not exists requests_path_trgm
  on public.requests using gin (path gin_trgm_ops);

-- Trigram index on request body (largest column, most impactful for search)
create index concurrently if not exists requests_body_trgm
  on public.requests using gin (body gin_trgm_ops);

-- Trigram index on headers cast to text (matches the search function's cast)
create index concurrently if not exists requests_headers_text_trgm
  on public.requests using gin ((headers::text) gin_trgm_ops);
