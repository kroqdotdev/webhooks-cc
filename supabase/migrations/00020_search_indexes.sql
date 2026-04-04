-- ============================================================================
-- Migration 00020: Enable pg_trgm for search index support
--
-- The trigram extension enables GIN indexes that accelerate ILIKE '%...%'
-- patterns used by search_requests() and search_requests_count().
--
-- The actual indexes must be created CONCURRENTLY (outside a transaction).
-- See supabase/scripts/create_search_indexes.sql for the companion script.
-- ============================================================================

create extension if not exists pg_trgm;
