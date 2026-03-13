-- Additional schema support for the staged Supabase migration.
-- Keeps the next control-plane and receiver slices small and explicit.

create or replace function public.check_and_increment_ephemeral(p_endpoint_id uuid)
returns table(request_count integer)
language plpgsql
security definer set search_path = ''
as $$
begin
  return query
  update public.endpoints
  set request_count = request_count + 1
  where id = p_endpoint_id
    and is_ephemeral = true
    and request_count < 25
    and (expires_at is null or expires_at > now())
  returning public.endpoints.request_count;
end;
$$;

create index if not exists users_plan_period_end
  on public.users(plan, period_end)
  where period_end is not null;
