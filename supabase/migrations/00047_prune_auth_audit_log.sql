-- ============================================================================
-- Migration 00047: keep the GoTrue audit log for one year
--
-- auth.audit_log_entries records every sign-in, sign-up, token refresh, and
-- password reset with the account's email and name. GoTrue never prunes it,
-- and the rows have no foreign key to auth.users, so they outlive account
-- deletion. The privacy policy promises a year for security and audit logs,
-- the same window prune_audit_events() (migration 00041) applies to
-- public.audit_events.
--
-- Volume is small (about 11,000 rows in the first seven months), so the
-- nightly delete scans the table without an index; adding one would mean
-- changing a table GoTrue owns and migrates.
-- ============================================================================

create or replace function public.prune_auth_audit_log()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from auth.audit_log_entries where created_at < now() - interval '1 year';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.prune_auth_audit_log() from public, anon, authenticated;

-- pg_cron 1.3+ already upserts named jobs; unscheduling first keeps a re-run
-- from ever leaving a duplicate.
select cron.unschedule(jobid) from cron.job where jobname = 'prune-auth-audit-log-daily';
select cron.schedule(
  'prune-auth-audit-log-daily',
  '27 3 * * *',
  'select public.prune_auth_audit_log();'
);

notify pgrst, 'reload schema';
