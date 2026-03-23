-- ============================================================================
-- Migration 00012: Partition requests table by received_at (daily ranges)
--
-- Converts the requests table from a regular heap table to a
-- range-partitioned table on received_at with daily partitions.
--
-- Benefits:
--   - Old data cleanup becomes DROP PARTITION instead of DELETE (instant, no bloat)
--   - Index scans touch only relevant partitions (partition pruning)
--   - VACUUM operates on smaller per-partition tables
--
-- Steps:
--   1. Rename old table and drop its indexes
--   2. Create new partitioned table with same columns
--   3. Create initial daily partitions (45 days back to 7 days ahead)
--   4. Migrate existing data
--   5. Drop old table
--   6. Re-apply RLS policies
--   7. Update Supabase Realtime publication
--   8. Create manage_request_partitions() function
--   9. Replace cleanup_old_requests() with thin wrapper
--  10. Replace cron job
-- ============================================================================

-- ============================================================================
-- 1. RENAME OLD TABLE + DROP OLD INDEXES
-- ============================================================================

-- Drop indexes first (they reference the old table)
DROP INDEX IF EXISTS public.requests_endpoint_time;
DROP INDEX IF EXISTS public.requests_user_time;
DROP INDEX IF EXISTS public.requests_received_at;

ALTER TABLE public.requests RENAME TO requests_old;

-- ============================================================================
-- 2. CREATE PARTITIONED TABLE
-- ============================================================================
-- PK must include the partition key (received_at).
-- FK on endpoint_id preserved for referential integrity.

CREATE TABLE public.requests (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id      uuid NOT NULL REFERENCES public.endpoints(id) ON DELETE CASCADE,
  user_id          uuid,
  method           text NOT NULL,
  path             text NOT NULL,
  headers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  body             text,
  query_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_type     text,
  ip               text NOT NULL,
  size             integer NOT NULL DEFAULT 0,
  received_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Recreate the same indexes on the partitioned parent
CREATE INDEX requests_endpoint_time ON public.requests(endpoint_id, received_at DESC);
CREATE INDEX requests_user_time ON public.requests(user_id, received_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX requests_received_at ON public.requests(received_at);
CREATE INDEX requests_id ON public.requests(id);

-- ============================================================================
-- 3. CREATE INITIAL PARTITIONS
-- ============================================================================
-- Default partition catches any rows that don't fit a named partition.
-- Daily partitions: 45 days in the past through 7 days in the future.

CREATE TABLE public.requests_default PARTITION OF public.requests DEFAULT;
GRANT ALL ON public.requests_default TO postgres, service_role;
GRANT SELECT ON public.requests_default TO authenticated, anon;

DO $$
DECLARE
  d date;
  partition_name text;
  start_ts timestamptz;
  end_ts timestamptz;
BEGIN
  FOR d IN
    SELECT dd::date
      FROM generate_series(
        (CURRENT_DATE - INTERVAL '45 days')::date,
        (CURRENT_DATE + INTERVAL '7 days')::date,
        '1 day'::interval
      ) AS dd
  LOOP
    partition_name := 'requests_' || to_char(d, 'YYYYMMDD');
    start_ts := d::timestamptz;
    end_ts   := (d + INTERVAL '1 day')::timestamptz;

    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.requests FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_ts, end_ts
    );

    EXECUTE format('GRANT ALL ON public.%I TO postgres, service_role', partition_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon', partition_name);
  END LOOP;
END
$$;

-- ============================================================================
-- 4. MIGRATE DATA
-- ============================================================================
-- Explicit column list for safety (avoids column-order mismatches).

INSERT INTO public.requests (
  id, endpoint_id, user_id, method, path, headers, body,
  query_params, content_type, ip, size, received_at
)
SELECT
  id, endpoint_id, user_id, method, path, headers, body,
  query_params, content_type, ip, size, received_at
FROM public.requests_old;

-- ============================================================================
-- 5. DROP OLD TABLE
-- ============================================================================
-- CASCADE drops any remaining constraints/policies referencing requests_old.

DROP TABLE public.requests_old CASCADE;

-- ============================================================================
-- 6. RE-APPLY RLS
-- ============================================================================
-- Matches current policy state from migrations 00008 + 00011.

ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;

-- SELECT: owner only (with (select auth.uid()) optimization from 00011)
CREATE POLICY requests_select ON public.requests
  FOR SELECT USING (user_id = (select auth.uid()));

-- INSERT: blocked for clients (receiver uses service_role, bypasses RLS)
CREATE POLICY requests_insert ON public.requests
  FOR INSERT WITH CHECK (false);

-- ============================================================================
-- 7. UPDATE REALTIME PUBLICATION
-- ============================================================================
-- The old table reference is gone (dropped with CASCADE or rename).
-- Add the new partitioned table with publish_via_partition_root so that
-- inserts into child partitions appear as if from the parent table.

DO $$
BEGIN
  -- Remove stale reference (may already be gone after DROP CASCADE)
  BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.requests;
  EXCEPTION
    WHEN undefined_object THEN NULL;
  END;

  -- Add partitioned table
  ALTER PUBLICATION supabase_realtime ADD TABLE public.requests;
END
$$;

ALTER PUBLICATION supabase_realtime SET (publish_via_partition_root = true);

-- ============================================================================
-- 8. CREATE manage_request_partitions() FUNCTION
-- ============================================================================
-- Called daily by cron. Handles:
--   a) Creating partitions for the next 7 days (detaches/reattaches default
--      to avoid range overlap, moves stray rows into the new partition)
--   b) Dropping partitions older than 32 days (1-day buffer past 31-day retention)
--
-- Returns a table with counts of created and dropped partitions.

CREATE OR REPLACE FUNCTION public.manage_request_partitions()
RETURNS TABLE(created integer, dropped integer)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d date;
  partition_name text;
  start_ts timestamptz;
  end_ts timestamptz;
  v_created integer := 0;
  v_dropped integer := 0;
  cutoff_date date;
  partitions_to_create text[] := '{}';
  starts timestamptz[] := '{}';
  ends timestamptz[] := '{}';
  i integer;
BEGIN
  -- ---------------------------------------------------------------
  -- A. CREATE PARTITIONS FOR THE NEXT 7 DAYS
  -- ---------------------------------------------------------------

  -- Collect all partitions that need to be created
  FOR d IN
    SELECT dd::date
      FROM generate_series(
        CURRENT_DATE,
        (CURRENT_DATE + INTERVAL '7 days')::date,
        '1 day'::interval
      ) AS dd
  LOOP
    partition_name := 'requests_' || to_char(d, 'YYYYMMDD');

    -- Skip if this partition already exists
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = partition_name
    ) THEN
      partitions_to_create := partitions_to_create || partition_name;
      starts := starts || d::timestamptz;
      ends := ends || (d + INTERVAL '1 day')::timestamptz;
    END IF;
  END LOOP;

  -- If any partitions need creating, detach default ONCE, create all, reattach ONCE
  IF array_length(partitions_to_create, 1) > 0 THEN
    -- Detach default partition once to avoid range overlap
    ALTER TABLE public.requests DETACH PARTITION public.requests_default;

    FOR i IN 1 .. array_length(partitions_to_create, 1)
    LOOP
      -- Create the new daily partition
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.requests FOR VALUES FROM (%L) TO (%L)',
        partitions_to_create[i], starts[i], ends[i]
      );

      -- Move any rows from default that belong in the new partition
      EXECUTE format(
        'WITH moved AS (
           DELETE FROM public.requests_default
            WHERE received_at >= %L AND received_at < %L
           RETURNING *
         )
         INSERT INTO public.%I SELECT * FROM moved',
        starts[i], ends[i], partitions_to_create[i]
      );
    END LOOP;

    -- Reattach default partition once
    ALTER TABLE public.requests ATTACH PARTITION public.requests_default DEFAULT;

    -- Grant permissions on each new partition
    FOR i IN 1 .. array_length(partitions_to_create, 1)
    LOOP
      EXECUTE format('GRANT ALL ON public.%I TO postgres, service_role', partitions_to_create[i]);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon', partitions_to_create[i]);
    END LOOP;

    v_created := array_length(partitions_to_create, 1);
  END IF;

  -- ---------------------------------------------------------------
  -- B. DROP PARTITIONS OLDER THAN 32 DAYS
  -- ---------------------------------------------------------------
  cutoff_date := CURRENT_DATE - INTERVAL '32 days';

  FOR partition_name IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE p.relname = 'requests'
       AND n.nspname = 'public'
       AND c.relname ~ '^requests_\d{8}$'     -- only dated partitions
       AND c.relname <> 'requests_default'     -- never drop default
     ORDER BY c.relname
  LOOP
    -- Extract date from partition name (requests_YYYYMMDD)
    d := to_date(substring(partition_name FROM '\d{8}$'), 'YYYYMMDD');

    IF d < cutoff_date THEN
      EXECUTE format('ALTER TABLE public.requests DETACH PARTITION public.%I', partition_name);
      EXECUTE format('DROP TABLE public.%I', partition_name);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_created, v_dropped;
END;
$$;

-- Permissions: only service_role (and postgres) can call this
REVOKE ALL ON FUNCTION public.manage_request_partitions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.manage_request_partitions() FROM anon;
REVOKE ALL ON FUNCTION public.manage_request_partitions() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.manage_request_partitions() TO service_role;

-- ============================================================================
-- 9. REPLACE cleanup_old_requests() WITH THIN WRAPPER
-- ============================================================================
-- Preserves the existing interface (returns integer = number of dropped partitions)
-- so that any callers (including free-user cleanup) keep working.
--
-- Note: cleanup_free_user_requests() is intentionally NOT updated to use
-- partition drops. Partitions contain mixed free/pro user data, so dropping
-- an entire partition would delete pro user data too. That function must
-- continue using row-level DELETEs filtered by user plan.

CREATE OR REPLACE FUNCTION public.cleanup_old_requests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_dropped integer;
BEGIN
  SELECT dropped INTO v_dropped
    FROM public.manage_request_partitions();
  RETURN coalesce(v_dropped, 0);
END;
$$;

-- ============================================================================
-- 10. CRON JOBS
-- ============================================================================
-- Remove old job, add new one at 00:30 UTC daily.

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-requests-daily');
EXCEPTION
  WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule(
  'manage-request-partitions-daily',
  '30 0 * * *',
  'SELECT * FROM public.manage_request_partitions();'
);
