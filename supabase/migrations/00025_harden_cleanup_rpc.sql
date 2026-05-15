-- Ensure the ephemeral cleanup RPC remains service-role only after later
-- CREATE OR REPLACE FUNCTION migrations.

revoke all on function public.cleanup_expired_ephemeral_endpoints() from public;
revoke all on function public.cleanup_expired_ephemeral_endpoints() from anon;
revoke all on function public.cleanup_expired_ephemeral_endpoints() from authenticated;
grant execute on function public.cleanup_expired_ephemeral_endpoints() to service_role;
