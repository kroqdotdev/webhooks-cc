-- ============================================================================
-- Migration 00033: Team seat-based billing (Polar)
-- Part 1: schema. Teams get their own subscription + pooled quota state.
-- ============================================================================

alter table public.teams
  add column if not exists polar_customer_id     text,
  add column if not exists polar_subscription_id text,
  add column if not exists subscription_status   text
    check (subscription_status in ('active', 'canceled', 'past_due')),
  add column if not exists seats                 integer not null default 0,
  add column if not exists requests_used         bigint  not null default 0,
  add column if not exists request_limit         bigint  not null default 0,
  add column if not exists period_start          timestamptz,
  add column if not exists period_end            timestamptz,
  add column if not exists cancel_at_period_end  boolean not null default false;

create unique index if not exists teams_polar_customer
  on public.teams(polar_customer_id) where polar_customer_id is not null;
create unique index if not exists teams_polar_subscription
  on public.teams(polar_subscription_id) where polar_subscription_id is not null;
create index if not exists teams_period_end
  on public.teams(period_end) where subscription_status is not null;

alter table public.team_members
  add column if not exists polar_seat_id text;

alter table public.requests
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists requests_team
  on public.requests(team_id) where team_id is not null;
