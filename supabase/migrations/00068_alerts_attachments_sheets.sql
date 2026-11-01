-- 00068: features for every plan.
--
--   1. retention_cap(endpoints): the longest retention an endpoint may have,
--      its billing account's (the oldest active team share's, else the
--      owner's), as a PostgREST computed column, so endpoint reads carry it
--      without another query.
--   2. Destinations say how attachments travel (attachments: 'links', the
--      default, signed download links; 'inline', base64 up to a size per
--      delivery and links for the rest; 'none') and gain a 'sheets' format
--      (Google Sheets), whose settings live in the new config column. The
--      claim returns both; without p_all it leaves Sheets destinations to a
--      worker that knows them.
--   3. Alerts: endpoint_alerts holds each endpoint's alert settings and the
--      checker's state, alert_events every alert opened and when it was
--      resolved. The web app's checker leases endpoints with
--      claim_alert_checks() and writes the rest itself.
--      claim_destination_deliveries() leases more of one destination's due
--      deliveries, so Sheets appends a batch of rows per call.
--   4. google_connections: a user's Google account, for Sheets destinations;
--      the refresh token is encrypted by the web app (lib/crypto.ts).
--
-- Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. Retention cap per endpoint
create or replace function public.retention_cap(e public.endpoints)
returns integer
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select public.account_retention_days(null, t.id)
       from public.team_endpoints te
       join public.teams t on t.id = te.team_id
      where te.endpoint_id = e.id
        and t.subscription_status is not null
      order by te.shared_at asc
      limit 1),
    public.account_retention_days(e.user_id, null)
  )
$$;

-- 2. Attachments and Sheets on destinations
alter table public.endpoint_destinations
  add column if not exists attachments text not null default 'links',
  add column if not exists config jsonb;

alter table public.endpoint_destinations drop constraint if exists endpoint_destinations_attachments_check;
alter table public.endpoint_destinations
  add constraint endpoint_destinations_attachments_check
  check (attachments in ('none', 'links', 'inline')) not valid;

alter table public.endpoint_destinations drop constraint if exists endpoint_destinations_config_check;
alter table public.endpoint_destinations
  add constraint endpoint_destinations_config_check
  check (config is null or (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 65536)) not valid;

alter table public.endpoint_destinations drop constraint if exists endpoint_destinations_format_check;
alter table public.endpoint_destinations
  add constraint endpoint_destinations_format_check
  check (format is null or format in (
    'as_received', 'json', 'chat', 'template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin',
    'sheets'
  )) not valid;
-- Checked without blocking writes to the table (a plain ADD CONSTRAINT would).
alter table public.endpoint_destinations validate constraint endpoint_destinations_format_check;

-- 00064's claim with the attachment mode and the destination's config.
drop function if exists public.claim_email_deliveries(integer, integer, integer);
drop function if exists public.claim_email_deliveries(integer, integer, integer, boolean);
create function public.claim_email_deliveries(
  p_limit         integer default 16,
  p_per_endpoint  integer default 2,
  p_lease_seconds integer default 60,
  p_all           boolean default false
)
returns table (
  delivery_id               uuid,
  request_id                uuid,
  endpoint_id               uuid,
  attempt                   integer,
  kind                      text,
  queued_at                 timestamptz,
  forward_url               text,
  forward_secret_encrypted  text,
  forward_format            text,
  forward_headers_encrypted text,
  forward_append_path       boolean,
  forward_retry_seconds     integer,
  forward_sent_field        text,
  show_email_extracts       boolean,
  endpoint_slug             text,
  endpoint_name             text,
  destination_id            uuid,
  destination_name          text,
  destination_filter        jsonb,
  body_template             jsonb,
  message_template          text,
  signing_provider          text,
  bypass_filter             boolean,
  throttle_seconds          integer,
  email_fields              jsonb,
  mailgun_key_encrypted     text,
  attachments               text,
  destination_config        jsonb
)
language sql
security definer set search_path = ''
as $$
  -- A delivery the old capture_webhook() queued while this migration ran
  -- has no destination: it belongs to the endpoint's forward destination.
  -- (Removing a destination settles what of it is waiting first, so no other
  -- pending delivery lacks one.) Goes with the forward_* columns.
  update public.email_deliveries d
     set destination_id = dest.id
    from public.endpoint_destinations dest
   where d.destination_id is null
     and d.status = 'pending'
     and dest.endpoint_id = d.endpoint_id
     and dest.legacy_role = 'forward';

  -- Backstops: a delivery whose sends keep being interrupted before a result
  -- is recorded fails instead of being claimed forever; one whose
  -- destination went, was switched off or no longer takes its kind (a
  -- capture that raced the change) is settled.
  update public.email_deliveries
     set status = 'failed',
         last_error = 'The delivery was interrupted too many times.',
         finished_at = now(),
         locked_until = null
   where status = 'pending'
     and attempts >= 12
     and (locked_until is null or locked_until <= now());

  update public.email_deliveries d
     set status = 'failed',
         last_error = case
           when dest.id is null then 'The destination was removed.'
           when not dest.enabled then 'The destination was switched off.'
           when d.kind = 'http' then 'The destination no longer takes HTTP requests.'
           else 'The destination no longer takes emails.'
         end,
         finished_at = now(),
         locked_until = null
    from public.email_deliveries pending
    left join public.endpoint_destinations dest on dest.id = pending.destination_id
   where d.id = pending.id
     and pending.status = 'pending'
     and (pending.locked_until is null or pending.locked_until <= now())
     and pending.next_attempt_at <= now()
     and (dest.id is null
          or not dest.enabled
          or not case pending.kind when 'email' then dest.email else dest.http end);

  with in_flight as (
    select d.destination_id, count(*)::integer as n
      from public.email_deliveries d
     where d.status = 'pending'
       and d.locked_until > now()
     group by d.destination_id
  ),
  pending as (
    select d.id, d.destination_id, d.created_at, d.next_attempt_at, d.locked_until,
           -- Sheets goes one claim at a time: that claim appends the rest
           -- of what is due in the same call (claim_destination_deliveries).
           dest.keep_order or dest.format = 'sheets' as keep_order,
           row_number() over (
             partition by d.destination_id order by d.created_at, d.id
           ) as rn_order
      from public.email_deliveries d
      join public.endpoint_destinations dest on dest.id = d.destination_id
     where d.status = 'pending'
       and d.attempts < 12
       and dest.enabled
       and case d.kind when 'email' then dest.email else dest.http end
       and (p_all
            or (dest.secret_encrypted is not null
                and coalesce(dest.format, '') not in
                    ('template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin', 'sheets')
                and dest.filter is null
                and dest.message_template is null))
  ),
  due as (
    select p.id, p.destination_id, p.next_attempt_at, p.keep_order, p.rn_order,
           row_number() over (
             partition by p.destination_id order by p.next_attempt_at, p.created_at
           ) as rn
      from pending p
     where p.next_attempt_at <= now()
       and (p.locked_until is null or p.locked_until <= now())
  ),
  candidates as (
    select d.id
      from due d
      left join in_flight f on f.destination_id = d.destination_id
     where case
             when d.keep_order then d.rn_order = 1 and coalesce(f.n, 0) = 0
             else d.rn + coalesce(f.n, 0) <= greatest(p_per_endpoint, 1)
           end
     order by d.next_attempt_at
     limit greatest(least(p_limit, 100), 1)
  ),
  locked as (
    select d.id
      from public.email_deliveries d
     where d.id in (select c.id from candidates c)
       and d.status = 'pending'
       and (d.locked_until is null or d.locked_until <= now())
       for update skip locked
  )
  update public.email_deliveries d
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
         attempts = d.attempts + 1
    from public.endpoint_destinations dest, public.endpoints e
   where d.id in (select l.id from locked l)
     and dest.id = d.destination_id
     and e.id = d.endpoint_id
  returning d.id, d.request_id, d.endpoint_id, d.attempts, d.kind,
            -- The retry window counts from the first try, after any delay.
            d.created_at + make_interval(secs => dest.delay_seconds),
            dest.url, encode(dest.secret_encrypted, 'base64'), dest.format,
            encode(dest.headers_encrypted, 'base64'), dest.append_path,
            dest.retry_seconds, dest.sent_field, e.show_email_extracts, e.slug, e.name,
            dest.id, dest.name, dest.filter, dest.body_template, dest.message_template,
            e.signing_provider, d.bypass_filter, dest.throttle_seconds,
            e.email_fields, encode(dest.mailgun_key_encrypted, 'base64'),
            dest.attachments, dest.config;
$$;

revoke all on function public.claim_email_deliveries(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, integer, integer, boolean)
  to service_role;

-- More due deliveries of one destination, for a worker that sends several at
-- once (Google Sheets appends a batch of rows in one call, which keeps inside
-- its quotas). Leased like the main claim.
create or replace function public.claim_destination_deliveries(
  p_destination_id uuid,
  p_limit          integer default 49,
  p_lease_seconds  integer default 60
)
returns table (delivery_id uuid, request_id uuid, attempt integer, kind text)
language sql
security definer set search_path = ''
as $$
  update public.email_deliveries d
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
         attempts = d.attempts + 1
   where d.id in (
     select x.id
       from public.email_deliveries x
      where x.destination_id = p_destination_id
        and x.status = 'pending'
        and x.attempts < 12
        and x.next_attempt_at <= now()
        and (x.locked_until is null or x.locked_until <= now())
        -- Still wanted: the destination is on and still takes this kind
        -- (the owner may have changed it since the first claim).
        and exists (
          select 1 from public.endpoint_destinations dest
           where dest.id = p_destination_id
             and dest.enabled
             and (case x.kind when 'email' then dest.email else dest.http end)
        )
      order by x.created_at, x.id
      limit least(greatest(p_limit, 1), 500)
      for update skip locked
   )
  returning d.id, d.request_id, d.attempts, d.kind;
$$;

-- 3. Alerts
create table if not exists public.endpoint_alerts (
  endpoint_id            uuid primary key references public.endpoints(id) on delete cascade,
  enabled                boolean not null default true,
  -- Open a fields alert after this many emails in a row miss a field (null: off).
  field_failures         integer check (field_failures between 1 and 100),
  -- ... or when this share (percent) of the last 20 emails missed one (null: off).
  field_failure_share    integer check (field_failure_share between 1 and 100),
  -- Fields that must be found; null means every field.
  required_fields        text[],
  -- Open a silence alert after this many hours without an email (null: off).
  silence_hours          integer check (silence_hours between 1 and 720),
  -- Open an alert when a delivery fails for good.
  destination_failures   boolean not null default false,
  notify_email           boolean not null default true,
  -- Chat or webhook destinations of this endpoint that also get alerts.
  notify_destination_ids uuid[] not null default '{}',
  -- The checker's state.
  checked_through        timestamptz,
  checked_through_id     uuid,
  deliveries_checked_through timestamptz,
  failure_streak         integer not null default 0,
  -- The last 20 outcomes, oldest first: '1' every required field found, '0' not.
  recent_outcomes        text not null default '' check (recent_outcomes ~ '^[01]{0,20}$'),
  next_check_at          timestamptz not null default now(),
  locked_until           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists endpoint_alerts_due
  on public.endpoint_alerts (next_check_at) where enabled;

create table if not exists public.alert_events (
  id                  uuid primary key default gen_random_uuid(),
  endpoint_id         uuid not null references public.endpoints(id) on delete cascade,
  kind                text not null check (kind in ('fields', 'silence', 'destination')),
  -- The destination id for destination alerts; null otherwise.
  subject             text,
  opened_at           timestamptz not null default now(),
  resolved_at         timestamptz,
  details             jsonb not null default '{}'::jsonb,
  notified_open_at    timestamptz,
  notified_resolve_at timestamptz,
  notify_attempts     integer not null default 0
);

create unique index if not exists alert_events_one_open
  on public.alert_events (endpoint_id, kind, coalesce(subject, '')) where resolved_at is null;
create index if not exists alert_events_endpoint_time
  on public.alert_events (endpoint_id, opened_at desc);
create index if not exists alert_events_unnotified
  on public.alert_events (opened_at)
  where notified_open_at is null or (resolved_at is not null and notified_resolve_at is null);

alter table public.endpoint_alerts enable row level security;
alter table public.alert_events enable row level security;
revoke all on table public.endpoint_alerts from public, anon, authenticated;
revoke all on table public.alert_events from public, anon, authenticated;
grant select, insert, update, delete on table public.endpoint_alerts to service_role;
grant select, insert, update, delete on table public.alert_events to service_role;

-- Endpoints whose alerts are due, leased so several web processes can check.
create or replace function public.claim_alert_checks(
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns setof public.endpoint_alerts
language sql
security definer set search_path = ''
as $$
  update public.endpoint_alerts a
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10))
   where a.endpoint_id in (
     select x.endpoint_id
       from public.endpoint_alerts x
      where x.enabled
        and x.next_check_at <= now()
        and (x.locked_until is null or x.locked_until <= now())
      order by x.next_check_at
      limit least(greatest(p_limit, 1), 200)
      for update skip locked
   )
  returning a.*;
$$;

-- 4. Google accounts for Sheets destinations
create table if not exists public.google_connections (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  google_sub              text not null check (length(google_sub) between 1 and 255),
  google_email            text check (length(google_email) <= 320),
  refresh_token_encrypted bytea not null,
  scopes                  text not null default '',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, google_sub)
);

alter table public.google_connections enable row level security;
revoke all on table public.google_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.google_connections to service_role;

-- 5. Grants
revoke all on function public.retention_cap(public.endpoints) from public, anon, authenticated;
grant execute on function public.retention_cap(public.endpoints) to service_role;
revoke all on function public.claim_destination_deliveries(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_destination_deliveries(uuid, integer, integer) to service_role;
revoke all on function public.claim_alert_checks(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_alert_checks(integer, integer) to service_role;

commit;

alter table public.endpoint_destinations validate constraint endpoint_destinations_attachments_check;
alter table public.endpoint_destinations validate constraint endpoint_destinations_config_check;

notify pgrst, 'reload schema';
