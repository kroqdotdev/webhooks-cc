-- =============================================================
-- 00015_teams.sql — Teams, members, invites, endpoint sharing
-- =============================================================

-- 1. Teams
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.teams enable row level security;
create policy teams_deny_all_select on public.teams for select using (false);
create policy teams_deny_all_insert on public.teams for insert with check (false);
create policy teams_deny_all_update on public.teams for update using (false);
create policy teams_deny_all_delete on public.teams for delete using (false);

-- 2. Team members
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique(team_id, user_id)
);

alter table public.team_members enable row level security;
create policy team_members_deny_all_select on public.team_members for select using (false);
create policy team_members_deny_all_insert on public.team_members for insert with check (false);
create policy team_members_deny_all_update on public.team_members for update using (false);
create policy team_members_deny_all_delete on public.team_members for delete using (false);

create index team_members_user on public.team_members(user_id);
create index team_members_team on public.team_members(team_id);

-- 3. Team invites
create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  invited_by uuid not null references public.users(id) on delete cascade,
  invited_email text not null,
  invited_user_id uuid references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  unique(team_id, invited_email)
);

alter table public.team_invites enable row level security;
create policy team_invites_deny_all_select on public.team_invites for select using (false);
create policy team_invites_deny_all_insert on public.team_invites for insert with check (false);
create policy team_invites_deny_all_update on public.team_invites for update using (false);
create policy team_invites_deny_all_delete on public.team_invites for delete using (false);

create index team_invites_email on public.team_invites(invited_email);
create index team_invites_user on public.team_invites(invited_user_id);
create index team_invites_team on public.team_invites(team_id);

-- 4. Team endpoints (junction table for sharing)
create table public.team_endpoints (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  endpoint_id uuid not null references public.endpoints(id) on delete cascade,
  shared_by uuid not null references public.users(id) on delete cascade,
  shared_at timestamptz not null default now(),
  unique(team_id, endpoint_id)
);

alter table public.team_endpoints enable row level security;
create policy team_endpoints_deny_all_select on public.team_endpoints for select using (false);
create policy team_endpoints_deny_all_insert on public.team_endpoints for insert with check (false);
create policy team_endpoints_deny_all_update on public.team_endpoints for update using (false);
create policy team_endpoints_deny_all_delete on public.team_endpoints for delete using (false);

create index team_endpoints_team on public.team_endpoints(team_id);
create index team_endpoints_endpoint on public.team_endpoints(endpoint_id);
