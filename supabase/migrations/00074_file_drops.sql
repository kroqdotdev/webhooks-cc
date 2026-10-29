-- 00074: file drops (mailhooks roadmap, phase 7).
--
-- A destination of format 'file_drop' writes each captured request (or a
-- batch of them) as a CSV, JSON or XML file to the owner's SFTP, FTP/FTPS or
-- S3-compatible server. Its settings are in config (no secrets); the
-- password, private key or S3 secret is drop_secret_encrypted (AES-GCM with
-- SIGNING_SECRET_KEY, like signing secrets) and never leaves the server.
-- Deliveries are made by the web app's forwarding worker, through the egress
-- proxy on the MX host in production. File drops are a Business feature
-- (plan_entitlements.file_drops, 00067): file_drops_allowed() says whether an
-- endpoint's plan has them, and a drop on a plan without them pauses.
--
-- Re-runnable. Apply in autocommit mode (see AGENTS.md).

-- 1. The format and the secret
alter table public.endpoint_destinations
  add column if not exists drop_secret_encrypted bytea;

alter table public.endpoint_destinations drop constraint if exists endpoint_destinations_format_check;
alter table public.endpoint_destinations
  add constraint endpoint_destinations_format_check
  check (format is null or format in (
    'as_received', 'json', 'chat', 'template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin',
    'sheets', 'file_drop'
  )) not valid;
alter table public.endpoint_destinations validate constraint endpoint_destinations_format_check;

-- 2. The main claim: file drops, like Sheets, one claim per destination.
begin;
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
           -- Sheets and file drops go one claim at a time: that claim takes
           -- the rest of what is due in the same call
           -- (claim_destination_deliveries, claim_drop_batch).
           dest.keep_order or dest.format in ('sheets', 'file_drop') as keep_order,
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
                    ('template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin', 'sheets',
                     'file_drop')
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

commit;

-- 3. A batch drop: everything waiting for the destination once its oldest
-- delivery is due (the destination's delay is how long a batch collects),
-- so one file holds what arrived in that time. Leased like the main claim.
drop function if exists public.claim_drop_batch(uuid, integer, integer);
create function public.claim_drop_batch(
  p_destination_id uuid,
  p_limit          integer default 499,
  p_lease_seconds  integer default 300
)
returns table (
  delivery_id uuid,
  request_id uuid,
  attempt integer,
  kind text,
  queued_at timestamptz,
  bypass_filter boolean
)
language sql
security definer set search_path = ''
as $$
  update public.email_deliveries d
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5)),
         attempts = d.attempts + 1
    from public.endpoint_destinations dest
   where dest.id = p_destination_id
     and d.id in (
     select x.id
       from public.email_deliveries x
      where x.destination_id = p_destination_id
        and x.status = 'pending'
        and x.attempts < 12
        and (x.locked_until is null or x.locked_until <= now())
      order by x.created_at, x.id
      limit least(greatest(p_limit, 1), 500)
      for update skip locked
   )
  returning d.id, d.request_id, d.attempts, d.kind,
            d.created_at + make_interval(secs => dest.delay_seconds), d.bypass_filter;
$$;

-- 4. Whether an endpoint's plan has file drops: the team that is billed for
-- it (the oldest live share, as capture_webhook() picks), else its owner's.
create or replace function public.file_drops_allowed(p_endpoint_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select (public.account_entitlements(null, t.id)).file_drops
       from public.team_endpoints te
       join public.teams t on t.id = te.team_id
      where te.endpoint_id = p_endpoint_id
        and t.subscription_status is not null
      order by te.shared_at asc
      limit 1),
    (select (public.account_entitlements(e.user_id, null)).file_drops
       from public.endpoints e
      where e.id = p_endpoint_id
        and e.user_id is not null),
    false
  )
$$;

revoke all on function public.claim_drop_batch(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.file_drops_allowed(uuid) from public, anon, authenticated;
grant execute on function public.claim_drop_batch(uuid, integer, integer) to service_role;
grant execute on function public.file_drops_allowed(uuid) to service_role;

notify pgrst, 'reload schema';
