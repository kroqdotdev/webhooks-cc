-- 00071: the site an account uses (webhooks.cc or mailhooks.cc), so emails
-- sent outside a request (quota, alerts) link where its session is.
-- Sessions are per host. Set by the web app's sign-in routes to the site
-- the person last signed in on. Re-runnable.

alter table public.users
  add column if not exists home_site text not null default 'webhooks';

-- Added unchecked and validated after, so the scan of users does not hold
-- the table's exclusive lock.
alter table public.users drop constraint if exists users_home_site_check;
alter table public.users
  add constraint users_home_site_check check (home_site in ('webhooks', 'mailhooks')) not valid;
alter table public.users validate constraint users_home_site_check;

-- Adds one layout to the end of an endpoint's layouts, under the row's lock,
-- only while the endpoint still has the number of layouts the caller checked
-- the new list against and no layout with the new one's id: two imports at
-- once never write over each other (the later one is asked to read again).
create or replace function public.append_endpoint_layout(
  p_endpoint_id    uuid,
  p_layout         jsonb,
  p_expected_count integer
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_layouts jsonb;
begin
  select coalesce(e.layouts, '[]'::jsonb) into v_layouts
    from public.endpoints e
   where e.id = p_endpoint_id
   for update;
  if not found then
    return false;
  end if;
  -- Counted as the app reads them (lib/parsing/stored.ts): entries with a
  -- string id and name.
  if (select count(*) from jsonb_array_elements(v_layouts) l
       where jsonb_typeof(l->'id') = 'string' and jsonb_typeof(l->'name') = 'string')
       <> p_expected_count
     or exists (select 1 from jsonb_array_elements(v_layouts) l where l->>'id' = p_layout->>'id') then
    return false;
  end if;
  update public.endpoints
     set layouts = v_layouts || jsonb_build_array(p_layout)
   where id = p_endpoint_id;
  return true;
end;
$$;

revoke all on function public.append_endpoint_layout(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.append_endpoint_layout(uuid, jsonb, integer) to service_role;

notify pgrst, 'reload schema';
