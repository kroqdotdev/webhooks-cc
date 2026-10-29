-- 00072: custom inbound domains (mailhooks roadmap, phase 5).
--
-- An account on Business (or a team with Team Business) adds its own domain,
-- proves it with a TXT record and points its MX at the MX host; mail to the
-- domain then lands on its endpoints: by local part, or on a catch-all
-- endpoint. The receiver resolves each recipient at a custom domain through
-- resolve_inbound_recipient() and captures it like mail to the capture
-- domain. The web app checks DNS when a domain is added and again every day;
-- a domain whose records are gone for three checks in a row lapses and its
-- mail is refused. Domains past what the plan allows (included domains plus
-- extra ones bought) are kept but refused, oldest verified first.
--
-- Re-runnable.

create table if not exists public.inbound_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  domain text not null,
  -- The TXT record's value, mailhooks-verify=<token>.
  token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  status text not null default 'pending',
  verified_at timestamptz,
  last_checked_at timestamptz,
  failed_checks integer not null default 0,
  catch_all_endpoint_id uuid references public.endpoints(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint inbound_domains_owner check ((user_id is null) <> (team_id is null)),
  constraint inbound_domains_status check (status in ('pending', 'verified', 'lapsed')),
  constraint inbound_domains_domain check (
    domain = lower(domain)
    and length(domain) <= 253
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  )
);

-- A domain once verified belongs to one owner; others may add it, pending,
-- but never verify it while it is held.
create unique index if not exists inbound_domains_held
  on public.inbound_domains (domain) where status <> 'pending';
create unique index if not exists inbound_domains_user_domain
  on public.inbound_domains (user_id, domain) where user_id is not null;
create unique index if not exists inbound_domains_team_domain
  on public.inbound_domains (team_id, domain) where team_id is not null;
create index if not exists inbound_domains_team on public.inbound_domains (team_id)
  where team_id is not null;
create index if not exists inbound_domains_catch_all on public.inbound_domains (catch_all_endpoint_id)
  where catch_all_endpoint_id is not null;
create index if not exists inbound_domains_check_due on public.inbound_domains (last_checked_at)
  where status <> 'pending';

create table if not exists public.inbound_domain_routes (
  domain_id uuid not null references public.inbound_domains(id) on delete cascade,
  local_part text not null,
  endpoint_id uuid not null references public.endpoints(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (domain_id, local_part),
  constraint inbound_domain_routes_local_part check (
    local_part = lower(local_part) and local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
  )
);
create index if not exists inbound_domain_routes_endpoint
  on public.inbound_domain_routes (endpoint_id);

-- Server routes only (service role): no client role reads or writes these.
alter table public.inbound_domains enable row level security;
alter table public.inbound_domain_routes enable row level security;
revoke all on table public.inbound_domains from anon, authenticated;
revoke all on table public.inbound_domain_routes from anon, authenticated;

-- Extra domains bought on top of the plan's (the capacity add-on).
alter table public.users add column if not exists extra_domains integer not null default 0;
alter table public.teams add column if not exists extra_domains integer not null default 0;

-- How many custom domains an owner may use now.
create or replace function public.inbound_domains_allowed(p_user_id uuid, p_team_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when p_user_id is not null then (
      select coalesce(pe.custom_domains, 0) + u.extra_domains
        from public.users u
        join public.plan_entitlements pe on pe.key = u.plan
       where u.id = p_user_id
    )
    else (
      select case
               when t.subscription_status is null then 0
               else coalesce(pe.custom_domains, 0) + t.extra_domains
             end
        from public.teams t
        join public.plan_entitlements pe
          on pe.key = case when t.business then 'team_business' else 'team' end
       where t.id = p_team_id
    )
  end
$$;

-- The endpoint mail to local@domain lands on: {status, slug}. status is ok,
-- unknown (no such address on a domain we receive for) or relay_denied (not
-- a domain we receive for: unknown, unverified, lapsed, or past the plan).
create or replace function public.resolve_inbound_recipient(p_domain text, p_local text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_domain public.inbound_domains%rowtype;
  v_rank bigint;
  v_endpoint uuid;
  v_slug text;
begin
  select * into v_domain
    from public.inbound_domains d
   where d.domain = lower(rtrim(p_domain, '.'))
     and d.status = 'verified';
  if not found then
    return jsonb_build_object('status', 'relay_denied');
  end if;

  -- The owner's verified domains in the order they were verified: those
  -- past the allowance are kept but receive nothing.
  select r.rank into v_rank
    from (
      select d.id, row_number() over (order by d.verified_at, d.id) as rank
        from public.inbound_domains d
       where d.status = 'verified'
         and (d.user_id = v_domain.user_id or d.team_id = v_domain.team_id)
    ) r
   where r.id = v_domain.id;
  if v_rank > public.inbound_domains_allowed(v_domain.user_id, v_domain.team_id) then
    return jsonb_build_object('status', 'relay_denied');
  end if;

  select rt.endpoint_id into v_endpoint
    from public.inbound_domain_routes rt
   where rt.domain_id = v_domain.id
     and rt.local_part = lower(p_local);
  if v_endpoint is null then
    v_endpoint := v_domain.catch_all_endpoint_id;
  end if;
  if v_endpoint is null then
    return jsonb_build_object('status', 'unknown');
  end if;

  -- Only the owner's endpoints (a team's: those shared with it), checked
  -- here too in case an endpoint changed hands after the route was made.
  select e.slug into v_slug
    from public.endpoints e
   where e.id = v_endpoint
     and (
       (v_domain.user_id is not null and e.user_id = v_domain.user_id)
       or (
         v_domain.team_id is not null
         and exists (
           select 1 from public.team_endpoints te
            where te.team_id = v_domain.team_id and te.endpoint_id = e.id
         )
       )
     );
  if v_slug is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  return jsonb_build_object('status', 'ok', 'slug', v_slug);
end;
$$;

revoke all on function public.inbound_domains_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function public.resolve_inbound_recipient(text, text) from public, anon, authenticated;
grant execute on function public.inbound_domains_allowed(uuid, uuid) to service_role;
grant execute on function public.resolve_inbound_recipient(text, text) to service_role;

-- Addresses at a customer's verified domain never become account emails:
-- their mail is readable through this app, like the capture domain's
-- (base is 00052). It reads inbound_domains, so it runs as its owner.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  email_domain text;
begin
  email_domain := rtrim(
    substring(lower(btrim(coalesce(event #>> '{user,email}', ''))) from '@([^@]*)$'),
    '.'
  );
  if email_domain = 'mailhooks.cc' or email_domain like '%.mailhooks.cc' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Addresses at mailhooks.cc cannot be used for an account. Sign up with your own email address.'
      )
    );
  end if;
  if exists (
    select 1 from public.inbound_domains d
     where d.domain = email_domain and d.status <> 'pending'
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Addresses at a domain that receives mail through mailhooks.cc cannot be used for an account. Sign up with another email address.'
      )
    );
  end if;
  return '{}'::jsonb;
end;
$$;

comment on function public.hook_before_user_created(jsonb) is
  'GoTrue before-user-created hook: refuses accounts at the capture domain (00052) and at customers'' inbound domains (00072).';

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

notify pgrst, 'reload schema';
