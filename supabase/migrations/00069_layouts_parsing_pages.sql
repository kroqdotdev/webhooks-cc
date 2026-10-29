-- 00069: extraction v2. Layouts, the parse step and parsed pages.
--
--   1. endpoints.layouts: the ordered list of layouts (packages/sdk/src/email/
--      layouts.ts); the first whose match holds reads the email.
--   2. request_parses: one parse job per email captured on an endpoint with
--      layouts. capture_webhook() queues the job instead of the deliveries;
--      the web app's parse worker leases it (claim_request_parses), parses
--      the attachments in the sandboxed parser, runs the layouts, stores the
--      result and calls complete_request_parse(), which queues the
--      deliveries in the same transaction. The job row is the durable queue
--      entry, so a crash only delays a parse; a job that keeps failing is
--      completed without a result, so its deliveries still go.
--   3. Parsed pages, metered like requests: each account has an allowance
--      per period from its entitlements (parsed_pages), one-time page credits
--      (credit_pages, never expire) and, with page add-ons, monthly page
--      blocks (page_block_pages) and overage up to a maximum (phase 3 sells
--      them; the columns are here so the metering is one function).
--      take_parsed_pages() charges a file's pages all at once or not at all:
--      allowance first, then credits, then overage. Paid accounts count per
--      quota period; free accounts, whose quota period is a day, get a
--      monthly window of their own for pages.
--
-- capture_webhook() and check_email_recipient() change together, as always;
-- check_email_recipient() is unchanged here (parsing never refuses mail).
-- Every statement runs on its own (autocommit; see 00067 for why). Apply in
-- autocommit mode (see AGENTS.md).


-- 1. Layouts
alter table public.endpoints
  add column if not exists layouts jsonb not null default '[]'::jsonb;

alter table public.endpoints drop constraint if exists endpoints_layouts_check;
alter table public.endpoints
  add constraint endpoints_layouts_check
  check (jsonb_typeof(layouts) = 'array'
         and jsonb_array_length(layouts) <= 50
         and pg_column_size(layouts) <= 524288) not valid;

-- Layouts an endpoint may use: its billing account's entitlement (the first
-- active team it is shared with, as retention_cap(), else its owner's plan).
-- Layouts past it are kept but not used.
create or replace function public.layouts_cap(e public.endpoints)
returns integer
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select (public.account_entitlements(null, t.id)).layouts_per_endpoint
       from public.team_endpoints te
       join public.teams t on t.id = te.team_id
      where te.endpoint_id = e.id
        and t.subscription_status is not null
      order by te.shared_at asc
      limit 1),
    (public.account_entitlements(e.user_id, null)).layouts_per_endpoint
  )
$$;

-- 1b. Alerts read when mail last arrived from the endpoint row, so they work
-- for endpoints that delete their requests right after delivery; and the
-- field check keeps the ids it has seen, so an email stored late (an MX
-- retry carries its first arrival time, up to an hour old) is still checked.
alter table public.endpoints
  add column if not exists last_email_at timestamptz;
alter table public.endpoint_alerts
  add column if not exists seen_ids uuid[] not null default '{}';
alter table public.alert_events
  add column if not exists notify_claimed_until timestamptz;

-- 2. Parse jobs
-- Its foreign keys lock requests and endpoints; taken in the order a capture
-- takes them (requests, then endpoints), so the two cannot deadlock.
begin;
lock table public.requests in share row exclusive mode;
lock table public.endpoints in share row exclusive mode;
create table if not exists public.request_parses (
  request_id   uuid primary key references public.requests(id) on delete cascade,
  endpoint_id  uuid not null references public.endpoints(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'done', 'failed')),
  attempts     integer not null default 0,
  locked_until timestamptz,
  -- The parsed email (packages/sdk/src/email/layouts.ts ParsedEmail).
  result       jsonb,
  pages        integer not null default 0 check (pages >= 0),
  error        text,
  -- Queue the deliveries when the parse completes (false for a parse redone
  -- in the dashboard without sending).
  deliver      boolean not null default true,
  -- Redone by a replay: its deliveries are redeliveries (no delay, no
  -- throttle), not a capture's.
  redelivery   boolean not null default false,
  -- The worker's claim: only the claim that is current may complete the job,
  -- so a parse that outlived its lease, or ran while the job was redone,
  -- is discarded.
  claim        uuid,
  -- Pages charged per attachment index, so a retry or a replay never charges
  -- a file twice (only pages beyond what it already paid for).
  charged      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- The worker keeps the result to about 1 MB; this is the backstop.
  constraint request_parses_result_size check (result is null or pg_column_size(result) <= 4194304)
);

commit;

create index if not exists request_parses_due
  on public.request_parses (created_at) where status = 'pending';
create index if not exists request_parses_endpoint
  on public.request_parses (endpoint_id);

alter table public.request_parses enable row level security;
revoke all on table public.request_parses from public, anon, authenticated;
grant select, insert, update, delete on table public.request_parses to service_role;

-- 3. Pages
alter table public.users
  add column if not exists pages_used integer not null default 0,
  add column if not exists pages_period_start timestamptz,
  add column if not exists credit_pages bigint not null default 0,
  add column if not exists page_block_pages integer not null default 0,
  add column if not exists page_overage_active boolean not null default false,
  add column if not exists page_overage_max integer not null default 0,
  add column if not exists page_overage_used integer not null default 0,
  add column if not exists page_overage_period_start timestamptz,
  add column if not exists page_overage_total bigint not null default 0,
  add column if not exists page_overage_reported bigint not null default 0,
  add column if not exists page_overage_reporting_to bigint,
  add column if not exists page_overage_report_lease timestamptz;

alter table public.teams
  add column if not exists pages_used integer not null default 0,
  add column if not exists pages_period_start timestamptz,
  add column if not exists credit_pages bigint not null default 0,
  add column if not exists page_block_pages integer not null default 0,
  add column if not exists page_overage_active boolean not null default false,
  add column if not exists page_overage_max integer not null default 0,
  add column if not exists page_overage_used integer not null default 0,
  add column if not exists page_overage_period_start timestamptz,
  add column if not exists page_overage_total bigint not null default 0,
  add column if not exists page_overage_reported bigint not null default 0,
  add column if not exists page_overage_reporting_to bigint,
  add column if not exists page_overage_report_lease timestamptz;

alter table public.users drop constraint if exists users_pages_check;
alter table public.users
  add constraint users_pages_check
  check (pages_used >= 0 and credit_pages >= 0 and page_block_pages >= 0
         and page_overage_max >= 0 and page_overage_used >= 0) not valid;
alter table public.teams drop constraint if exists teams_pages_check;
alter table public.teams
  add constraint teams_pages_check
  check (pages_used >= 0 and credit_pages >= 0 and page_block_pages >= 0
         and page_overage_max >= 0 and page_overage_used >= 0) not valid;

-- The start of the page window an account is in now: the quota period for
-- monthly plans and teams, otherwise a month from the first parse.
create or replace function public.page_window_start(
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_quota_period text,
  p_pages_start  timestamptz
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  -- A monthly period that ended before the renewal moved it starts the next
  -- window at its end, the start the renewal will give it, so the window
  -- does not restart twice.
  select case
    when p_quota_period = 'month' and p_period_start is not null
         and (p_period_end is null or p_period_end > now())
      then p_period_start
    when p_quota_period = 'month' and p_period_start is not null
      then p_period_end
    when p_pages_start is not null and p_pages_start + interval '1 month' > now()
      then p_pages_start
    else now()
  end
$$;

-- The account's pages: what the allowance has left this window, one-time
-- credits, and overage left (only with page add-ons and overage on).
create or replace function public.parsed_pages_balance(p_user_id uuid, p_team_id uuid)
returns table (
  window_start  timestamptz,
  allowance     integer,
  used          integer,
  credits       bigint,
  overage_left  integer
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_ent   public.plan_entitlements;
  v_row   record;
  v_start timestamptz;
begin
  v_ent := public.account_entitlements(p_user_id, p_team_id);
  if p_team_id is not null then
    select t.period_start, t.period_end, t.pages_used, t.pages_period_start, t.credit_pages,
           t.page_block_pages, t.page_overage_active, t.page_overage_max, t.page_overage_used,
           t.page_overage_period_start, 'month'::text as quota_period
      into v_row
      from public.teams t where t.id = p_team_id;
  else
    select u.period_start, u.period_end, u.pages_used, u.pages_period_start, u.credit_pages,
           u.page_block_pages, u.page_overage_active, u.page_overage_max, u.page_overage_used,
           u.page_overage_period_start, v_ent.quota_period as quota_period
      into v_row
      from public.users u where u.id = p_user_id;
  end if;
  if not found then
    return;
  end if;
  v_start := public.page_window_start(v_row.period_start, v_row.period_end,
                                      v_row.quota_period, v_row.pages_period_start);
  return query select
    v_start,
    v_ent.parsed_pages + case when v_ent.page_addons then v_row.page_block_pages else 0 end,
    -- Usage stored at or after the window's start is this window's, so
    -- rewriting the period start within a period never resets it.
    case when v_row.pages_period_start >= v_start then v_row.pages_used else 0 end,
    v_row.credit_pages,
    case
      when v_ent.page_addons and v_row.page_overage_active then
        greatest(v_row.page_overage_max - case
          when v_row.page_overage_period_start >= v_start
            then v_row.page_overage_used else 0 end, 0)
      else 0
    end;
end;
$$;

-- How many pages the account can still parse now.
create or replace function public.parsed_pages_available(p_user_id uuid, p_team_id uuid)
returns bigint
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(
    (select greatest(b.allowance - b.used, 0) + b.credits + b.overage_left
       from public.parsed_pages_balance(p_user_id, p_team_id) b),
    0)
$$;

-- Charges p_pages to the account, all or nothing: the allowance first, then
-- one-time credits, then overage. Returns {granted, allowance, credits,
-- overage}. The row lock makes concurrent parses of one account take turns.
create or replace function public.take_parsed_pages(
  p_user_id uuid,
  p_team_id uuid,
  p_pages   integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_b         record;
  v_left      integer;
  v_allowance integer;
  v_credits   integer;
  v_overage   integer;
begin
  if p_pages is null or p_pages <= 0 then
    return jsonb_build_object('granted', true, 'allowance', 0, 'credits', 0, 'overage', 0);
  end if;
  if p_team_id is not null then
    perform 1 from public.teams where id = p_team_id for update;
  else
    perform 1 from public.users where id = p_user_id for update;
  end if;
  if not found then
    return jsonb_build_object('granted', false);
  end if;

  select * into v_b from public.parsed_pages_balance(p_user_id, p_team_id);
  v_left := greatest(v_b.allowance - v_b.used, 0);
  if v_left + v_b.credits + v_b.overage_left < p_pages then
    return jsonb_build_object('granted', false);
  end if;
  v_allowance := least(v_left, p_pages);
  v_credits := least(v_b.credits, p_pages - v_allowance)::integer;
  v_overage := p_pages - v_allowance - v_credits;

  if p_team_id is not null then
    update public.teams
       set pages_used = case when pages_period_start >= v_b.window_start
                             then pages_used else 0 end + v_allowance,
           pages_period_start = case when pages_period_start >= v_b.window_start
                                     then pages_period_start else v_b.window_start end,
           credit_pages = credit_pages - v_credits,
           page_overage_used = case
             when v_overage = 0 then page_overage_used
             when page_overage_period_start >= v_b.window_start
               then page_overage_used + v_overage
             else v_overage end,
           page_overage_period_start = case
             when v_overage = 0 then page_overage_period_start
             when page_overage_period_start >= v_b.window_start then page_overage_period_start
             else v_b.window_start end,
           page_overage_total = page_overage_total + v_overage
     where id = p_team_id;
  else
    update public.users
       set pages_used = case when pages_period_start >= v_b.window_start
                             then pages_used else 0 end + v_allowance,
           pages_period_start = case when pages_period_start >= v_b.window_start
                                     then pages_period_start else v_b.window_start end,
           credit_pages = credit_pages - v_credits,
           page_overage_used = case
             when v_overage = 0 then page_overage_used
             when page_overage_period_start >= v_b.window_start
               then page_overage_used + v_overage
             else v_overage end,
           page_overage_period_start = case
             when v_overage = 0 then page_overage_period_start
             when page_overage_period_start >= v_b.window_start then page_overage_period_start
             else v_b.window_start end,
           page_overage_total = page_overage_total + v_overage
     where id = p_user_id;
  end if;
  return jsonb_build_object('granted', true, 'allowance', v_allowance,
                            'credits', v_credits, 'overage', v_overage);
end;
$$;

-- Charges a parsed attachment's pages once: a retry or a replay of the same
-- email pays only for pages beyond what that file already paid for (a file
-- parsed again in full after it was cut off at the balance).
create or replace function public.charge_parsed_file(
  p_request_id uuid,
  p_index      integer,
  p_user_id    uuid,
  p_team_id    uuid,
  p_pages      integer
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_charged jsonb;
  v_paid    integer;
  v_result  jsonb;
begin
  select charged into v_charged
    from public.request_parses
   where request_id = p_request_id
   for update;
  if not found then
    return jsonb_build_object('granted', false);
  end if;
  v_paid := coalesce((v_charged ->> p_index::text)::integer, 0);
  if coalesce(p_pages, 0) <= v_paid then
    return jsonb_build_object('granted', true, 'charged', 0);
  end if;
  v_result := public.take_parsed_pages(p_user_id, p_team_id, p_pages - v_paid);
  if coalesce((v_result ->> 'granted')::boolean, false) then
    update public.request_parses
       set charged = charged || jsonb_build_object(p_index::text, p_pages)
     where request_id = p_request_id;
    return v_result || jsonb_build_object('charged', p_pages - v_paid);
  end if;
  return v_result;
end;
$$;

-- Parse jobs that are due, leased so several web processes can parse.
drop function if exists public.claim_request_parses(integer, integer);
create function public.claim_request_parses(
  p_limit integer default 4,
  p_lease_seconds integer default 600
)
returns table (request_id uuid, endpoint_id uuid, attempts integer, claim uuid)
language plpgsql
security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_job record;
begin
  -- A job that was claimed five times and never completed (its process died
  -- each time) completes without a result, so its deliveries still go.
  for v_job in
    select x.request_id
      from public.request_parses x
     where x.status = 'pending'
       and x.attempts >= 5
       and (x.locked_until is null or x.locked_until <= now())
     limit 50
     for update skip locked
  loop
    perform public.finish_request_parse(
      v_job.request_id, 'failed', null, 0, 'The email could not be parsed.'
    );
  end loop;

  -- Fair across accounts: each endpoint owner has at most one job in flight
  -- and gets its oldest due job, so one account's queue (a flood of mail or
  -- a large replay) never holds back everyone else's. The lease is checked
  -- again under the row lock, so two workers cannot claim the same job.
  return query
  update public.request_parses p
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         attempts = p.attempts + 1,
         claim = gen_random_uuid()
   where p.status = 'pending'
     and p.attempts < 5
     and (p.locked_until is null or p.locked_until <= now())
     and p.request_id in (
       select ranked.request_id
         from (
           select x.request_id, x.created_at,
                  row_number() over (partition by e.user_id order by x.created_at) as rn
             from public.request_parses x
             join public.endpoints e on e.id = x.endpoint_id
            where x.status = 'pending'
              and x.attempts < 5
              and (x.locked_until is null or x.locked_until <= now())
              and not exists (
                select 1
                  from public.request_parses y
                  join public.endpoints e2 on e2.id = y.endpoint_id
                 where e2.user_id = e.user_id
                   and y.status = 'pending'
                   and y.locked_until > now()
              )
         ) ranked
        where ranked.rn = 1
        order by ranked.created_at
        limit least(greatest(p_limit, 1), 50)
     )
  returning p.request_id, p.endpoint_id, p.attempts, p.claim;
end;
$$;

-- Stores a parse and queues the email's deliveries in one transaction, so
-- the parsed result is in place before anything is sent. Returns how many
-- deliveries were queued; null when the job was not pending (completed
-- twice, or the request went).
create or replace function public.finish_request_parse(
  p_request_id uuid,
  p_status     text,
  p_result     jsonb,
  p_pages      integer,
  p_error      text default null
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_job         record;
  v_destination record;
  v_count       integer := 0;
  v_delivery    uuid;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'invalid parse status: %', p_status using errcode = '22023';
  end if;
  update public.request_parses
     set status = p_status,
         result = p_result,
         pages = pages + greatest(coalesce(p_pages, 0), 0),
         error = left(p_error, 1000),
         locked_until = null,
         finished_at = now(),
         claim = null
   where request_id = p_request_id
     and status = 'pending'
  returning endpoint_id, deliver, redelivery into v_job;
  if not found then
    return null;
  end if;
  if not v_job.deliver then
    return 0;
  end if;
  for v_destination in
    select d.id, d.delay_seconds
      from public.endpoint_destinations d
     where d.endpoint_id = v_job.endpoint_id
       and d.enabled
       and d.email
     order by d.position, d.created_at
  loop
    v_delivery := public.queue_destination_delivery(
      p_request_id, v_job.endpoint_id, v_destination.id, 'email', 1000, not v_job.redelivery
    );
    -- A capture's deliveries count from the capture, as they would without
    -- a parse: queued at its time and delayed from it, so parses finishing
    -- out of order do not reorder a keep-order destination.
    if v_delivery is not null and not v_job.redelivery then
      update public.email_deliveries d
         set created_at = r.received_at,
             next_attempt_at = least(d.next_attempt_at,
                                     r.received_at + make_interval(secs => v_destination.delay_seconds))
        from public.requests r
       where d.id = v_delivery
         and d.status = 'pending'
         and r.id = p_request_id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- The worker's completion: only the current claim completes the job.
drop function if exists public.complete_request_parse(uuid, text, jsonb, integer, text);
create function public.complete_request_parse(
  p_request_id uuid,
  p_claim      uuid,
  p_status     text,
  p_result     jsonb,
  p_pages      integer,
  p_error      text default null
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
begin
  perform 1
    from public.request_parses
   where request_id = p_request_id
     and status = 'pending'
     and claim = p_claim
   for update;
  if not found then
    return null;
  end if;
  return public.finish_request_parse(p_request_id, p_status, p_result, p_pages, p_error);
end;
$$;

-- Runs an email's layouts again (after they changed, or for a replay): back
-- to pending, with the deliveries queued again as redeliveries when p_deliver. Pages already parsed are not
-- charged twice; the worker reuses the stored parse of each attachment.
create or replace function public.redo_request_parse(p_request_id uuid, p_deliver boolean)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_endpoint uuid;
begin
  select r.endpoint_id into v_endpoint
    from public.requests r
   where r.id = p_request_id and r.kind = 'email';
  if not found then
    return false;
  end if;
  -- A job still pending from its capture keeps the capture's deliveries (and
  -- their delay and throttle); a parse running now is discarded (its claim
  -- no longer matches) and the job goes to the back of the queue.
  insert into public.request_parses (request_id, endpoint_id, deliver, redelivery)
  values (p_request_id, v_endpoint, p_deliver, true)
  on conflict (request_id) do update
     set deliver = case when public.request_parses.status = 'pending'
                        then public.request_parses.deliver or excluded.deliver
                        else excluded.deliver end,
         redelivery = case when public.request_parses.status = 'pending'
                           then public.request_parses.redelivery
                           else true end,
         status = 'pending',
         -- A job that already ran out of tries (its parse killed the
         -- process each time) stays out of them: replaying it cannot loop.
         attempts = case when public.request_parses.attempts >= 5
                         then public.request_parses.attempts else 0 end,
         locked_until = null,
         claim = null,
         error = null,
         finished_at = null,
         created_at = now();
  return true;
end;
$$;

-- 5. capture_webhook(): base is 00067; an email to an endpoint with layouts
-- queues a parse job instead of its deliveries.
create or replace function public.capture_webhook(
  p_slug        text,
  p_method      text,
  p_path        text,
  p_headers     jsonb,
  p_body        text,
  p_query_params jsonb,
  p_content_type text,
  p_ip          text,
  p_received_at timestamptz,
  p_body_raw    bytea default null,
  p_kind        text default 'http',
  p_email       jsonb default null,
  -- Message hash, stored on every email row.
  p_dedupe_key  text default null,
  -- True when the MX host answered "try later" for this message before.
  p_retry       boolean default false,
  -- Real size when the stored body is shorter than what was received.
  p_size        integer default null,
  -- The query string exactly as sent, for forwarding as received.
  p_query_raw   text default null,
  -- The id to store the request under (the receiver names stored objects
  -- after it); generated when null.
  p_request_id  uuid default null,
  -- m/{p_request_id}/ when the message and its attachments are in object
  -- storage.
  p_object_prefix text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_endpoint    record;
  v_user        record;
  v_quota       record;
  v_period      record;
  v_retry_after bigint;
  v_size        integer;
  v_mock        jsonb;
  v_slug        text;
  v_request_id  uuid;
  v_team            record;
  v_billing_team_id uuid;
  v_day             date;
  -- The row this capture's quota lands on; returned so the receiver can cap
  -- concurrent captures per account.
  v_billing_key     text;
  v_kind            text;
  v_existing_id     uuid;
  v_destination     record;
  -- How a capture past the allowance was paid for: 'credit' (a one-time
  -- block) or 'overage'; null when it was not.
  v_extra           text;
  v_included        boolean;
  v_team_active     boolean;
begin
  v_slug := p_slug;
  v_kind := coalesce(p_kind, 'http');
  if p_object_prefix is not null
     and (p_request_id is null or p_object_prefix <> 'm/' || p_request_id::text || '/') then
    raise exception 'object prefix must be m/<request id>/' using errcode = '22023';
  end if;
  if v_kind not in ('http', 'email') then
    raise exception 'invalid capture kind: %', v_kind using errcode = '22023';
  end if;
  v_day := (coalesce(p_received_at, now()) at time zone 'UTC')::date;

  -- 1. Look up endpoint by slug (now includes signing fields)
  select id, user_id, name, is_ephemeral, expires_at, mock_response, response_rules,
         request_count,
         signing_provider, signing_secret_encrypted, signing_header,
         agent_registration_id,
         -- Read only for email, so an HTTP capture never loads the layouts.
         case when v_kind = 'email' then jsonb_array_length(layouts) > 0 else false end
           as has_layouts
    into v_endpoint
    from public.endpoints
   where slug = v_slug;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 2. Check expiry
  if v_endpoint.expires_at is not null and v_endpoint.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  -- 2b. Email needs an owning account; nothing is billed or counted otherwise.
  if v_kind = 'email' and v_endpoint.user_id is null then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- 2c. Retry protection. Every attempt with a key takes this lock, so two
  -- attempts of one message on one endpoint run one after the other; a retry
  -- then finds the copy an earlier attempt committed and bills nothing.
  if p_dedupe_key is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(v_endpoint.id::text || ':' || p_dedupe_key, 0)
    );
    if coalesce(p_retry, false) then
      select id into v_existing_id
        from public.requests
       where endpoint_id = v_endpoint.id
         and dedupe_key = p_dedupe_key
       order by received_at desc
       limit 1;
      if v_existing_id is not null then
        return jsonb_build_object('status', 'duplicate', 'request_id', v_existing_id);
      end if;
    end if;
  end if;

  -- 3. Quota check (branching by endpoint type)
  if v_endpoint.is_ephemeral and v_endpoint.user_id is null then
    if v_endpoint.agent_registration_id is not null then
      -- Agent sandbox: one unit of the registration's budget, spent only
      -- while the registration is live and unclaimed. A capture the
      -- endpoint cap below then refuses has still spent its unit; the
      -- budget is small and never refunded, so that stays harmless.
      v_billing_key := 'agent:' || v_endpoint.agent_registration_id::text;
      update public.agent_registrations
         set sandbox_requests_used = sandbox_requests_used + 1
       where id = v_endpoint.agent_registration_id
         and claimed_at is null
         and revoked_at is null
         and expires_at > now()
         and sandbox_requests_used < sandbox_request_limit;

      if not found then
        perform public.bump_endpoint_daily_stats(v_endpoint.id, null, null, v_day, 0, 0, 1, 0);
        return jsonb_build_object('status', 'quota_exceeded', 'billing_key', v_billing_key);
      end if;
    else
      v_billing_key := 'endpoint:' || v_endpoint.id::text;
    end if;

    -- Ephemeral endpoint: atomic increment with 25-request cap
    select request_count into v_quota
      from public.check_and_increment_ephemeral(v_endpoint.id);

    if not found then
      perform public.bump_endpoint_daily_stats(v_endpoint.id, null, null, v_day, 0, 0, 1, 0);
      return jsonb_build_object('status', 'quota_exceeded', 'billing_key', v_billing_key);
    end if;

  elsif v_endpoint.user_id is not null then
    -- Team billing: oldest share into a team with an active subscription wins.
    select t.id, t.period_end, t.credit_requests, t.overage_active
      into v_team
      from public.team_endpoints te
      join public.teams t on t.id = te.team_id
     where te.endpoint_id = v_endpoint.id
       and t.subscription_status is not null
     order by te.shared_at asc
     limit 1;

    v_billing_key := case
      when v_team.id is not null then 'team:' || v_team.id::text
      else 'user:' || v_endpoint.user_id::text
    end;

    if v_team.id is not null then
      -- Pooled quota: atomic conditional increment on the single team row.
      -- The status condition re-checks the window between the select above
      -- and this update: a team deactivated in between must not be billed.
      update public.teams
         set requests_used = requests_used + 1
       where id = v_team.id
         and subscription_status is not null
         and requests_used < request_limit + block_requests;

      if found then
        v_billing_team_id := v_team.id;
      else
        -- No row updated: pool exhausted, or the team deactivated since the
        -- select. Only a still-active team may answer quota_exceeded; a
        -- deactivated one falls through to the owner's personal quota below.
        perform 1 from public.teams
         where id = v_team.id
           and subscription_status is not null;
        v_team_active := found;

        -- A still-active team past its pool spends a one-time block, then
        -- overage, before it answers quota_exceeded.
        if v_team_active and (v_team.credit_requests > 0 or v_team.overage_active) then
          v_extra := public.take_extra_request(null, v_team.id);
          if v_extra is not null then
            v_billing_team_id := v_team.id;
          end if;
        end if;

        if v_team_active and v_extra is null then
          v_retry_after := null;
          if v_team.period_end is not null and v_team.period_end > now() then
            v_retry_after := extract(epoch from (v_team.period_end - now()))::bigint * 1000;
          end if;

          perform public.bump_endpoint_daily_stats(
            v_endpoint.id, v_endpoint.user_id, v_team.id, v_day, 0, 0, 1, 0
          );
          return jsonb_build_object(
            'status', 'quota_exceeded',
            'retry_after', v_retry_after,
            'billing_key', v_billing_key
          );
        end if;
      end if;
    end if;

    if v_billing_team_id is null then
      -- Owned endpoint: check user quota
      select u.id, u.plan, u.request_limit, u.requests_used, u.period_end, u.credit_requests,
             u.overage_active, pe.quota_period
        into v_user
        from public.users u
        left join public.plan_entitlements pe on pe.key = u.plan
       where u.id = v_endpoint.user_id;

      if not found then
        return jsonb_build_object('status', 'not_found');
      end if;

      -- Free user with expired or unstarted period: start a new one. When
      -- concurrent captures race here, one starts the period and the others
      -- find no row to update once its lock is released; they carry on with
      -- the period it started instead of answering quota_exceeded.
      if v_user.quota_period = 'day' and (v_user.period_end is null or v_user.period_end <= now()) then
        select remaining, quota_limit, period_end_ts into v_period
          from public.start_free_period(v_endpoint.user_id);

        -- Refresh user row after period reset
        select u.id, u.plan, u.request_limit, u.requests_used, u.period_end, u.credit_requests,
               u.overage_active, pe.quota_period
          into v_user
          from public.users u
          left join public.plan_entitlements pe on pe.key = u.plan
         where u.id = v_endpoint.user_id;
      end if;

      -- Atomic quota check + decrement
      select remaining, quota_limit, period_end_ts into v_quota
        from public.check_and_decrement_quota(v_endpoint.user_id, 1);
      v_included := found;

      -- Past the allowance (plan plus recurring blocks): a one-time block,
      -- then overage, before quota_exceeded.
      if not v_included and (v_user.credit_requests > 0 or v_user.overage_active) then
        v_extra := public.take_extra_request(v_endpoint.user_id, null);
      end if;

      if not v_included and v_extra is null then
        -- Quota exceeded
        v_retry_after := null;
        if v_user.period_end is not null and v_user.period_end > now() then
          v_retry_after := extract(epoch from (v_user.period_end - now()))::bigint * 1000;
        end if;

        perform public.bump_endpoint_daily_stats(
          v_endpoint.id, v_endpoint.user_id, null, v_day, 0, 0, 1, 0
        );
        return jsonb_build_object(
          'status', 'quota_exceeded',
          'retry_after', v_retry_after,
          'billing_key', v_billing_key
        );
      end if;

      -- Emails billed to the user this period, for the usage split. The row
      -- is already locked by the decrement above; HTTP captures skip this.
      if v_kind = 'email' then
        update public.users
           set emails_used = case
                 when emails_period_start is not distinct from period_start then emails_used + 1
                 else 1
               end,
               emails_period_start = period_start
         where id = v_endpoint.user_id;
      end if;
    end if;

  end if;
  -- else: owned endpoint with null user_id but not ephemeral: allow through (no quota)

  -- 4. Insert the request (capture generated ID for post-response verification)
  v_size := case
    when p_size is not null and p_size >= 0 then p_size
    else coalesce(octet_length(p_body_raw), octet_length(p_body), 0)
  end;

  insert into public.requests (
    id, endpoint_id, user_id, team_id, method, path, headers, body, body_raw,
    query_params, content_type, ip, size, received_at, kind, email, dedupe_key, query_raw,
    object_prefix
  ) values (
    coalesce(p_request_id, gen_random_uuid()),
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, p_method, p_path, p_headers, p_body, p_body_raw,
    p_query_params, p_content_type, p_ip, v_size, p_received_at, v_kind, p_email, p_dedupe_key,
    nullif(left(p_query_raw, 8192), ''), p_object_prefix
  )
  returning id into v_request_id;

  -- 5. Increment endpoint request count (ephemeral already incremented above)
  -- (the count and when mail last arrived, in one update of the row)
  if not (v_endpoint.is_ephemeral and v_endpoint.user_id is null) then
    update public.endpoints
       set request_count = request_count + 1,
           last_email_at = case when v_kind = 'email' then now() else last_email_at end
     where id = v_endpoint.id;
  end if;

  -- 5b. Forwarding: queue one delivery per enabled destination that takes
  -- this kind, in the capture's own transaction, so a captured request is
  -- never lost before it is queued; the web app's worker sends them
  -- (claim_email_deliveries) and checks each destination's filter there.
  -- A destination switched off while this runs leaves at most a row the
  -- claim settles.
  -- An email to an endpoint with layouts is parsed first; the parse job is
  -- the durable queue entry, and complete_request_parse() queues the
  -- deliveries once the parsed result is stored.
  if v_kind = 'email' and v_endpoint.has_layouts then
    insert into public.request_parses (request_id, endpoint_id)
    values (v_request_id, v_endpoint.id);
  else
    for v_destination in
      select d.id
        from public.endpoint_destinations d
       where d.endpoint_id = v_endpoint.id
         and d.enabled
         and case v_kind when 'email' then d.email else d.http end
       order by d.position, d.created_at
    loop
      perform public.queue_destination_delivery(v_request_id, v_endpoint.id, v_destination.id, v_kind);
    end loop;
  end if;

  perform public.bump_endpoint_daily_stats(
    v_endpoint.id, v_endpoint.user_id, v_billing_team_id, v_day,
    1, (v_billing_team_id is not null)::integer, 0, v_size,
    (v_kind = 'email')::integer
  );

  -- 6. Build response
  v_mock := null;
  if v_endpoint.mock_response is not null
     and jsonb_typeof(v_endpoint.mock_response) = 'object'
     and (v_endpoint.mock_response ? 'status')
  then
    v_mock := v_endpoint.mock_response;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'request_id', v_request_id,
    'mock_response', v_mock,
    'response_rules', v_endpoint.response_rules,
    'retry_after', null::bigint,
    -- Notifications are destinations now (00063); the receiver sends none.
    'notification_url', null::text,
    'endpoint_name', v_endpoint.name,
    'signing_provider', v_endpoint.signing_provider,
    'signing_secret_encrypted', encode(v_endpoint.signing_secret_encrypted, 'base64'),
    'signing_header', v_endpoint.signing_header,
    'billing_key', v_billing_key
  );
end;
$$;


revoke all on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.capture_webhook(
  text, text, text, jsonb, text, jsonb, text, text, timestamptz, bytea, text, jsonb,
  text, boolean, integer, text, uuid, text
) to service_role;

-- 5b. Alert notices, leased so two web processes never send the same one.
create or replace function public.claim_alert_notices(p_limit integer default 50)
returns setof public.alert_events
language sql
security definer set search_path = ''
as $$
  update public.alert_events a
     set notify_claimed_until = now() + interval '2 minutes'
   where a.id in (
     select x.id
       from public.alert_events x
      where (x.notified_open_at is null
             or (x.resolved_at is not null and x.notified_resolve_at is null))
        and x.notify_attempts < 5
        and (x.notify_claimed_until is null or x.notify_claimed_until <= now())
      order by x.opened_at
      limit least(greatest(p_limit, 1), 200)
      for update skip locked
   )
  returning a.*;
$$;

-- 6. "Deliver, then delete" waits for the parse too, and for three minutes
-- after the last delivery settled, so the alert checker (every minute) sees
-- a delivery that failed for good before its row goes (base is 00067).
create or replace function public.cleanup_delivered_requests(p_limit integer default 1000)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.requests
   where ctid = any(array(
     select r.ctid
       from public.endpoints e
       join public.requests r on r.endpoint_id = e.id
      where e.delete_after_delivery
        and r.received_at < now() - interval '1 minute'
        and not exists (
          select 1 from public.email_deliveries d
           where d.request_id = r.id
             and (d.status = 'pending' or d.finished_at > now() - interval '3 minutes'))
        and not exists (
          select 1 from public.request_parses p
           where p.request_id = r.id
             and p.status = 'pending')
      limit least(greatest(coalesce(p_limit, 1000), 1), 10000)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 7. Grants: service role only.
revoke all on function public.layouts_cap(public.endpoints) from public, anon, authenticated;
revoke all on function public.page_window_start(timestamptz, timestamptz, text, timestamptz) from public, anon, authenticated;
revoke all on function public.parsed_pages_balance(uuid, uuid) from public, anon, authenticated;
revoke all on function public.parsed_pages_available(uuid, uuid) from public, anon, authenticated;
revoke all on function public.take_parsed_pages(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_request_parses(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_request_parse(uuid, uuid, text, jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.finish_request_parse(uuid, text, jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.charge_parsed_file(uuid, integer, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.redo_request_parse(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cleanup_delivered_requests(integer) from public, anon, authenticated;
revoke all on function public.claim_alert_notices(integer) from public, anon, authenticated;

grant execute on function public.layouts_cap(public.endpoints) to service_role;
grant execute on function public.page_window_start(timestamptz, timestamptz, text, timestamptz) to service_role;
grant execute on function public.parsed_pages_balance(uuid, uuid) to service_role;
grant execute on function public.parsed_pages_available(uuid, uuid) to service_role;
grant execute on function public.take_parsed_pages(uuid, uuid, integer) to service_role;
grant execute on function public.claim_request_parses(integer, integer) to service_role;
grant execute on function public.complete_request_parse(uuid, uuid, text, jsonb, integer, text) to service_role;
grant execute on function public.finish_request_parse(uuid, text, jsonb, integer, text) to service_role;
grant execute on function public.charge_parsed_file(uuid, integer, uuid, uuid, integer) to service_role;
grant execute on function public.redo_request_parse(uuid, boolean) to service_role;
grant execute on function public.cleanup_delivered_requests(integer) to service_role;
grant execute on function public.claim_alert_notices(integer) to service_role;


alter table public.endpoints validate constraint endpoints_layouts_check;
alter table public.users validate constraint users_pages_check;
alter table public.teams validate constraint teams_pages_check;

notify pgrst, 'reload schema';
