-- 00110: delivery counts for one destination
--
-- The delivery log's summary follows its destination filter. Same shape and
-- the same 100,000-row cap per count as delivery_summary() (00058), on the
-- destination index (email_deliveries_destination, 00063), so a busy
-- destination answers as fast as the endpoint-wide summary. The endpoint id
-- is checked too, so a destination id never reads another endpoint's log.
create or replace function public.delivery_summary_for_destination(
  p_endpoint_id    uuid,
  p_destination_id uuid,
  p_since          timestamptz
)
returns table (
  delivered_recent integer,
  failed_recent    integer,
  pending          integer,
  failed           integer,
  total            integer
)
language sql
stable
security definer set search_path = ''
as $$
  select
    (select count(*)::integer from (
      select 1 from public.email_deliveries
       where destination_id = p_destination_id and endpoint_id = p_endpoint_id
         and created_at >= p_since and status = 'succeeded'
       limit 100000) x),
    (select count(*)::integer from (
      select 1 from public.email_deliveries
       where destination_id = p_destination_id and endpoint_id = p_endpoint_id
         and created_at >= p_since and status = 'failed'
       limit 100000) x),
    (select count(*)::integer from (
      select 1 from public.email_deliveries
       where destination_id = p_destination_id and endpoint_id = p_endpoint_id
         and status = 'pending'
       limit 100000) x),
    (select count(*)::integer from (
      select 1 from public.email_deliveries
       where destination_id = p_destination_id and endpoint_id = p_endpoint_id
         and status = 'failed'
       limit 100000) x),
    (select count(*)::integer from (
      select 1 from public.email_deliveries
       where destination_id = p_destination_id and endpoint_id = p_endpoint_id
       limit 100000) x);
$$;

revoke all on function public.delivery_summary_for_destination(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.delivery_summary_for_destination(uuid, uuid, timestamptz)
  to service_role;
