-- 00064: email fields and inbound provider shapes.
--
-- 1. endpoints.email_fields: named fields picked out of every email the
--    endpoint captures ({name, from, header?, pattern} with an RE2 pattern,
--    at most 20). The web app runs them (lib/email-fields.ts) for the
--    dashboard, the request routes' extracts, forwarding and filters.
-- 2. endpoint_destinations.format also takes the shapes inbound mail
--    providers post (postmark, sendgrid, mailgun, cloudmailin), applied to
--    emails; mailgun_key_encrypted holds the owner's Mailgun signing key
--    (AES-GCM, like signing secrets), so a Mailgun form verifies.
-- 3. claim_email_deliveries() returns both. Without p_all (a worker older
--    than 00063) it leaves the new formats alone, as it does templates.
--
-- Service role only. Apply in autocommit mode (see AGENTS.md).

begin;

-- 1. Fields
alter table public.endpoints
  add column if not exists email_fields jsonb not null default '[]'::jsonb;

alter table public.endpoints drop constraint if exists endpoints_email_fields_check;
alter table public.endpoints
  add constraint endpoints_email_fields_check
  check (jsonb_typeof(email_fields) = 'array' and jsonb_array_length(email_fields) <= 20)
  not valid;

-- 2. Provider shapes
alter table public.endpoint_destinations
  add column if not exists mailgun_key_encrypted bytea;

alter table public.endpoint_destinations drop constraint if exists endpoint_destinations_format_check;
alter table public.endpoint_destinations
  add constraint endpoint_destinations_format_check
  check (format is null or format in (
    'as_received', 'json', 'chat', 'template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin'
  ));

commit;

alter table public.endpoints validate constraint endpoints_email_fields_check;

begin;

-- 4. 00063's claim, returning the endpoint's fields and the Mailgun key too.
-- Claims up to p_limit due deliveries and leases them for p_lease_seconds.
-- Without keep-order, at most p_per_endpoint of a destination are in flight
-- (the name stays from 00058); with it, only the destination's oldest
-- pending delivery may go, and only when none of its deliveries is in
-- flight. The leading columns are 00058's, read from the destination, so a
-- web app still running the old worker sends each delivery where it
-- belongs. That worker cannot send without a secret or fill in a template,
-- so without p_all only deliveries it can send are claimed; the rest wait
-- for the new worker, which passes p_all.
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
  mailgun_key_encrypted     text
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
           dest.keep_order,
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
                    ('template', 'postmark', 'sendgrid', 'mailgun', 'cloudmailin')
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
            e.email_fields, encode(dest.mailgun_key_encrypted, 'base64');
$$;

revoke all on function public.claim_email_deliveries(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_email_deliveries(integer, integer, integer, boolean)
  to service_role;

commit;

notify pgrst, 'reload schema';
