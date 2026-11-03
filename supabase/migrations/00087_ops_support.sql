-- ============================================================================
-- 00087: staff, the operations center and support tickets
-- ============================================================================
-- 1. Staff. `staff` lists the auth user ids that may open /ops. Rows are
--    inserted by hand with psql, never by a migration (the repository is
--    public), and keyed by id, never by email, so changing an address can
--    make no one staff. Staff accounts are on Business without a Polar
--    subscription: a BEFORE trigger on users keeps plan = 'business' (with its
--    request limit, a running 30-day period and cancel_at_period_end off) on
--    every write that would change it, so a revoked subscription or the
--    period job never moves a staff account off it. The trigger's WHEN clause
--    leaves captures (which only move requests_used) alone.
--    users.internal marks test accounts; staff and internal accounts are left
--    out of the ops metrics.
--
-- 2. Support tickets. A ticket belongs to the person who opened it (never
--    shared with a team). Messages are user or staff replies, staff-only
--    notes, or events (access granted, closed, reopened). Clients have no
--    access to any of it: every read and write goes through server routes
--    with the service role, which never return notes to users. Each change
--    that should email someone queues a row in support_notifications in the
--    same transaction, and the web app's sender drains it. A staff reply or
--    note-free event signals user:<id> over Realtime with the ticket id only.
--
--    Waiting: waiting_on says whose move it is and waiting_since since when.
--    A ticket waiting on the user gets a reminder after 3 days and closes
--    after 7 (support_auto_close, hourly). A user reply within 30 days of a
--    close reopens the ticket; after that the user opens a new one.
--
--    Access grants: a ticket's access_granted lets staff read the account's
--    captured contents (read-only) while the ticket is open and for 7 days
--    after it closes. The user can withdraw it at any time. Every staff view
--    is written to support_access_log, which the user can read.
--
--    Screenshots live in object storage under t/{ticket_id}/; deleting a
--    ticket queues the prefix in storage_deletions like a request's.
--
-- 3. Ops metrics. ops_rollup_day(day) writes one row per UTC day into
--    ops_daily_metrics from users, endpoint_daily_stats and the paid
--    accounts; the web app runs it (and fills in Polar's revenue figures) so
--    the overview never counts large tables on page load.
--
-- 4. Two-factor sign-in in the database: restrictive policies hold client
--    reads of users, endpoints, requests, api_keys, device_codes and
--    Realtime topics to aal2 for accounts with a verified authenticator.
--    session_mfa_ok(), which they call, is the one function here client
--    roles may execute.
--
-- storage_deletions now takes ticket prefixes (t/{id}/) as well.
--
-- Everything else is service-role only. Re-runnable. Apply in autocommit mode.
-- ============================================================================


-- 1. Staff -------------------------------------------------------------------

create table if not exists public.staff (
  user_id    uuid primary key references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.staff enable row level security;
revoke all on table public.staff from public, anon, authenticated;
grant select, insert, delete on table public.staff to service_role;

alter table public.users
  add column if not exists internal boolean not null default false;

create or replace function public.is_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (select 1 from public.staff s where s.user_id = p_user_id);
$$;

revoke all on function public.is_staff(uuid) from public, anon, authenticated;
grant execute on function public.is_staff(uuid) to service_role;

-- Keeps a staff account on Business. Runs last among the BEFORE triggers
-- (they fire in name order), after any proration trigger has set its limit.
create or replace function public.users_keep_staff_plan()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_limit integer;
begin
  if not exists (select 1 from public.staff s where s.user_id = new.id) then
    return new;
  end if;
  select pe.request_limit into v_limit
    from public.plan_entitlements pe where pe.key = 'business';
  new.plan := 'business';
  new.request_limit := coalesce(v_limit, new.request_limit);
  new.cancel_at_period_end := false;
  new.pending_plan := null;
  new.prorated_pages := null;
  new.prorated_window := null;
  if new.polar_subscription_id is null then
    -- No subscription: a plain monthly quota period that the period job
    -- rolls forward (it renews any non-free plan whose period has ended).
    new.billing_interval := null;
    new.billing_period_end := null;
    if new.period_end is null then
      new.period_start := now();
      new.period_end := now() + interval '30 days';
      new.requests_used := 0;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.users_keep_staff_plan() from public, anon, authenticated;

drop trigger if exists users_zz_keep_staff_plan on public.users;
create trigger users_zz_keep_staff_plan
  before update on public.users
  for each row
  when (
    old.plan is distinct from new.plan
    or old.request_limit is distinct from new.request_limit
    or old.cancel_at_period_end is distinct from new.cancel_at_period_end
    or old.period_end is distinct from new.period_end
    or old.polar_subscription_id is distinct from new.polar_subscription_id
    or old.pending_plan is distinct from new.pending_plan
  )
  execute function public.users_keep_staff_plan();

-- Adding staff applies the plan at once; removing staff puts an account
-- without a subscription back on free.
create or replace function public.staff_apply_plan()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_free_limit integer;
begin
  if tg_op = 'INSERT' then
    -- Any change the trigger above watches makes it run; it sets the rest.
    update public.users u
       set plan = 'business',
           request_limit = u.request_limit + 1
     where u.id = new.user_id;
    return null;
  end if;

  select pe.request_limit into v_free_limit
    from public.plan_entitlements pe where pe.key = 'free';
  update public.users u
     set plan = 'free',
         request_limit = coalesce(v_free_limit, 50),
         requests_used = 0,
         period_start = null,
         period_end = null,
         billing_interval = null,
         billing_period_end = null
   where u.id = old.user_id
     and u.polar_subscription_id is null;
  return null;
end;
$$;

revoke all on function public.staff_apply_plan() from public, anon, authenticated;

drop trigger if exists staff_apply_plan on public.staff;
create trigger staff_apply_plan
  after insert or delete on public.staff
  for each row
  execute function public.staff_apply_plan();


-- 2. Support tickets ---------------------------------------------------------

create table if not exists public.support_tickets (
  id                uuid primary key default gen_random_uuid(),
  number            bigint generated always as identity (start with 1001) unique,
  user_id           uuid not null references public.users(id) on delete cascade,
  site              text not null default 'webhooks'
                    check (site in ('webhooks', 'mailhooks')),
  category          text not null
                    check (category in ('billing', 'bug', 'email', 'forwarding', 'account', 'idea', 'other')),
  subject           text not null check (char_length(subject) between 1 and 200),
  status            text not null default 'open' check (status in ('open', 'closed')),
  waiting_on        text not null default 'support' check (waiting_on in ('support', 'user')),
  waiting_since     timestamptz not null default now(),
  blocking          boolean not null default false,
  endpoint_id       uuid references public.endpoints(id) on delete set null,
  notify_email      boolean not null default true,
  access_granted    boolean not null default false,
  access_changed_at timestamptz,
  snoozed_until     timestamptz,
  spam              boolean not null default false,
  context           jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 4096),
  has_attachments   boolean not null default false,
  reminder_sent_at  timestamptz,
  user_notified_at  timestamptz,
  closed_at         timestamptz,
  closed_by         text check (closed_by in ('user', 'staff', 'auto')),
  rating            smallint check (rating between 1 and 5),
  rating_comment    text check (char_length(rating_comment) <= 1000),
  rated_at          timestamptz,
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint support_tickets_closed check ((status = 'closed') = (closed_at is not null))
);

create index if not exists support_tickets_user
  on public.support_tickets (user_id, last_message_at desc);
create index if not exists support_tickets_queue
  on public.support_tickets (status, waiting_on, waiting_since);

alter table public.support_tickets enable row level security;
revoke all on table public.support_tickets from public, anon, authenticated;
grant select, insert, update, delete on table public.support_tickets to service_role;

create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.support_tickets(id) on delete cascade,
  author     text not null check (author in ('user', 'staff', 'system')),
  author_id  uuid references public.users(id) on delete set null,
  kind       text not null check (kind in ('message', 'note', 'event')),
  body       text not null default '' check (char_length(body) <= 20000),
  event      text check (event in ('access_granted', 'access_withdrawn', 'closed', 'reopened', 'auto_closed', 'reminded')),
  -- clock_timestamp, so messages written in one transaction keep their order.
  created_at timestamptz not null default clock_timestamp(),
  constraint support_messages_event check ((kind = 'event') = (event is not null))
);

alter table public.support_messages alter column created_at set default clock_timestamp();

create index if not exists support_messages_ticket
  on public.support_messages (ticket_id, created_at);

alter table public.support_messages enable row level security;
revoke all on table public.support_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.support_messages to service_role;

create table if not exists public.support_attachments (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  message_id   uuid not null references public.support_messages(id) on delete cascade,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes        integer not null check (bytes between 1 and 5242880),
  created_at   timestamptz not null default now()
);

create index if not exists support_attachments_message
  on public.support_attachments (message_id);
create index if not exists support_attachments_ticket
  on public.support_attachments (ticket_id);

alter table public.support_attachments enable row level security;
revoke all on table public.support_attachments from public, anon, authenticated;
grant select, insert, update, delete on table public.support_attachments to service_role;

create table if not exists public.support_notifications (
  id           bigint generated always as identity primary key,
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  kind         text not null check (kind in ('reply', 'closed', 'reminder', 'staff_new', 'staff_reply')),
  due_at       timestamptz not null default now(),
  locked_until timestamptz,
  attempts     integer not null default 0,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists support_notifications_due
  on public.support_notifications (due_at) where sent_at is null;
create index if not exists support_notifications_ticket
  on public.support_notifications (ticket_id);

alter table public.support_notifications enable row level security;
revoke all on table public.support_notifications from public, anon, authenticated;
grant select, insert, update, delete on table public.support_notifications to service_role;

create table if not exists public.support_saved_replies (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_saved_replies enable row level security;
revoke all on table public.support_saved_replies from public, anon, authenticated;
grant select, insert, update, delete on table public.support_saved_replies to service_role;

-- What staff looked at in an account, for the account's owner to read.
create table if not exists public.support_access_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  ticket_id  uuid references public.support_tickets(id) on delete set null,
  staff_id   uuid references public.users(id) on delete set null,
  action     text not null check (action in ('view_started', 'view_endpoint', 'view_request', 'view_ended')),
  target_id  text check (char_length(target_id) <= 128),
  created_at timestamptz not null default now()
);

create index if not exists support_access_log_user
  on public.support_access_log (user_id, created_at desc);

alter table public.support_access_log enable row level security;
revoke all on table public.support_access_log from public, anon, authenticated;
grant select, insert, delete on table public.support_access_log to service_role;

-- A staff member's read-only view of an account, opened from a ticket.
create table if not exists public.support_view_sessions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.users(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  ticket_id  uuid not null references public.support_tickets(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at   timestamptz
);

create index if not exists support_view_sessions_staff
  on public.support_view_sessions (staff_id, created_at desc);

alter table public.support_view_sessions enable row level security;
revoke all on table public.support_view_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.support_view_sessions to service_role;

-- Whether staff may read the contents of the ticket's account right now.
create or replace function public.support_grant_active(t public.support_tickets)
returns boolean
language sql
stable
set search_path = ''
as $$
  select t.access_granted
     and (t.status = 'open' or t.closed_at > now() - interval '7 days');
$$;

revoke all on function public.support_grant_active(public.support_tickets) from public, anon, authenticated;
grant execute on function public.support_grant_active(public.support_tickets) to service_role;

-- Queues a notification. A user reply email waits a minute and absorbs any
-- further staff replies in that minute, so a burst of messages is one email.
create or replace function public.support_queue_notification(p_ticket_id uuid, p_kind text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  -- Only into a notice still waiting: not one being sent right now (its
  -- replies are already read) and not one out of tries.
  if p_kind in ('reply', 'staff_reply') and exists (
    select 1 from public.support_notifications n
     where n.ticket_id = p_ticket_id and n.kind = p_kind and n.sent_at is null
       and n.attempts < 5
       and (n.locked_until is null or n.locked_until < now())
  ) then
    return;
  end if;
  -- A close notice carries the last reply, so a reply still waiting is dropped.
  if p_kind = 'closed' then
    delete from public.support_notifications n
     where n.ticket_id = p_ticket_id and n.kind in ('reply', 'reminder') and n.sent_at is null
       and (n.locked_until is null or n.locked_until < now());
  end if;
  insert into public.support_notifications (ticket_id, kind, due_at)
  values (
    p_ticket_id,
    p_kind,
    case when p_kind in ('reply', 'staff_reply') then now() + interval '1 minute' else now() end
  );
end;
$$;

revoke all on function public.support_queue_notification(uuid, text) from public, anon, authenticated;
grant execute on function public.support_queue_notification(uuid, text) to service_role;

create or replace function public.support_create_ticket(
  p_user_id     uuid,
  p_site        text,
  p_category    text,
  p_subject     text,
  p_body        text,
  p_blocking    boolean,
  p_endpoint_id uuid,
  p_notify      boolean,
  p_grant       boolean,
  p_context     jsonb
)
returns table (ticket_id uuid, ticket_number bigint, message_id uuid)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_ticket  public.support_tickets;
  v_message uuid;
  v_endpoint uuid;
begin
  -- Only an endpoint the user owns is linked.
  select e.id into v_endpoint
    from public.endpoints e
   where e.id = p_endpoint_id and e.user_id = p_user_id;

  insert into public.support_tickets (
    user_id, site, category, subject, blocking, endpoint_id, notify_email,
    access_granted, access_changed_at, context
  ) values (
    p_user_id, p_site, p_category, p_subject, coalesce(p_blocking, false), v_endpoint,
    coalesce(p_notify, true), coalesce(p_grant, false),
    case when p_grant then now() end, coalesce(p_context, '{}'::jsonb)
  )
  returning * into v_ticket;

  insert into public.support_messages (ticket_id, author, author_id, kind, body)
  values (v_ticket.id, 'user', p_user_id, 'message', p_body)
  returning id into v_message;

  if p_grant then
    insert into public.support_messages (ticket_id, author, author_id, kind, event)
    values (v_ticket.id, 'user', p_user_id, 'event', 'access_granted');
  end if;

  perform public.support_queue_notification(v_ticket.id, 'staff_new');

  return query select v_ticket.id, v_ticket.number, v_message;
end;
$$;

revoke all on function public.support_create_ticket(uuid, text, text, text, text, boolean, uuid, boolean, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.support_create_ticket(uuid, text, text, text, text, boolean, uuid, boolean, boolean, jsonb) to service_role;

-- Adds a reply or a note and moves the ticket on. p_close closes it after a
-- staff reply (or on its own, with an empty body). Raises 'ticket_closed'
-- for a user reply more than 30 days after the close.
create or replace function public.support_post_message(
  p_ticket_id uuid,
  p_author    text,
  p_author_id uuid,
  p_kind      text,
  p_body      text,
  p_close     boolean default false
)
returns table (message_id uuid, status text, waiting_on text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_ticket  public.support_tickets;
  v_message uuid;
begin
  select * into v_ticket from public.support_tickets t where t.id = p_ticket_id for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;

  if p_author = 'user' then
    if v_ticket.status = 'closed' then
      if v_ticket.closed_at < now() - interval '30 days' then
        raise exception 'ticket_closed' using errcode = 'P0001';
      end if;
      insert into public.support_messages (ticket_id, author, author_id, kind, event)
      values (p_ticket_id, 'user', p_author_id, 'event', 'reopened');
      -- Access that ran out with the close does not come back with the
      -- reopening: the user gives it again if they want to.
      if v_ticket.access_granted and v_ticket.closed_at <= now() - interval '7 days' then
        update public.support_tickets t
           set access_granted = false, access_changed_at = now()
         where t.id = p_ticket_id;
        insert into public.support_messages (ticket_id, author, author_id, kind, event)
        values (p_ticket_id, 'system', null, 'event', 'access_withdrawn');
      end if;
    end if;
    insert into public.support_messages (ticket_id, author, author_id, kind, body)
    values (p_ticket_id, 'user', p_author_id, 'message', p_body)
    returning id into v_message;
    update public.support_tickets t
       set status = 'open',
           closed_at = null,
           closed_by = null,
           waiting_since = case
             when t.waiting_on = 'support' and t.status = 'open' then t.waiting_since
             else now()
           end,
           waiting_on = 'support',
           snoozed_until = null,
           reminder_sent_at = null,
           last_message_at = now()
     where t.id = p_ticket_id;
    perform public.support_queue_notification(p_ticket_id, 'staff_reply');

  elsif p_kind = 'note' then
    insert into public.support_messages (ticket_id, author, author_id, kind, body)
    values (p_ticket_id, 'staff', p_author_id, 'note', p_body)
    returning id into v_message;

  else
    -- A bare close writes no message; anything else does, even without text
    -- (screenshots only).
    if char_length(coalesce(p_body, '')) > 0 or not coalesce(p_close, false) then
      insert into public.support_messages (ticket_id, author, author_id, kind, body)
      values (p_ticket_id, 'staff', p_author_id, 'message', coalesce(p_body, ''))
      returning id into v_message;
      update public.support_tickets t
         set status = 'open',
             closed_at = null,
             closed_by = null,
             waiting_on = 'user',
             waiting_since = now(),
             snoozed_until = null,
             reminder_sent_at = null,
             last_message_at = now()
       where t.id = p_ticket_id;
      if v_ticket.notify_email and not coalesce(p_close, false) then
        perform public.support_queue_notification(p_ticket_id, 'reply');
      end if;
    end if;
    if coalesce(p_close, false) then
      perform public.support_close_ticket(p_ticket_id, 'staff', p_author_id);
    end if;
  end if;

  return query
    select v_message, t.status, t.waiting_on
      from public.support_tickets t where t.id = p_ticket_id;
end;
$$;

create or replace function public.support_close_ticket(
  p_ticket_id uuid,
  p_by        text,
  p_actor_id  uuid
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_ticket public.support_tickets;
begin
  update public.support_tickets t
     set status = 'closed',
         closed_at = now(),
         closed_by = p_by,
         snoozed_until = null
   where t.id = p_ticket_id and t.status = 'open'
  returning * into v_ticket;
  if not found then
    return false;
  end if;
  insert into public.support_messages (ticket_id, author, author_id, kind, event)
  values (
    p_ticket_id,
    case p_by when 'user' then 'user' when 'staff' then 'staff' else 'system' end,
    p_actor_id,
    'event',
    case when p_by = 'auto' then 'auto_closed' else 'closed' end
  );
  -- Someone who closed their own ticket needs no email about it.
  if v_ticket.notify_email and p_by <> 'user' then
    perform public.support_queue_notification(p_ticket_id, 'closed');
  end if;
  return true;
end;
$$;

revoke all on function public.support_post_message(uuid, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.support_post_message(uuid, text, uuid, text, text, boolean) to service_role;
revoke all on function public.support_close_ticket(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.support_close_ticket(uuid, text, uuid) to service_role;

-- The user gives or withdraws access to their account on a ticket.
create or replace function public.support_set_access(p_ticket_id uuid, p_user_id uuid, p_granted boolean)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.support_tickets t
     set access_granted = p_granted,
         access_changed_at = now()
   where t.id = p_ticket_id
     and t.user_id = p_user_id
     and t.access_granted is distinct from p_granted;
  if not found then
    return false;
  end if;
  insert into public.support_messages (ticket_id, author, author_id, kind, event)
  values (p_ticket_id, 'user', p_user_id, 'event',
          case when p_granted then 'access_granted' else 'access_withdrawn' end);
  if not p_granted then
    -- A withdrawal ends every open view of the account at once.
    update public.support_view_sessions s
       set ended_at = now()
     where s.user_id = p_user_id and s.ended_at is null and s.expires_at > now()
       and not exists (
         select 1 from public.support_tickets t
          where t.user_id = p_user_id and t.id <> p_ticket_id
            and public.support_grant_active(t)
       );
  end if;
  return true;
end;
$$;

revoke all on function public.support_set_access(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.support_set_access(uuid, uuid, boolean) to service_role;

-- Reminders after 3 days waiting on the user, a close after 7.
create or replace function public.support_auto_close()
returns table (reminded integer, closed integer)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_reminded integer := 0;
  v_closed   integer := 0;
  v_ticket   record;
begin
  for v_ticket in
    select t.id from public.support_tickets t
     where t.status = 'open' and t.waiting_on = 'user'
       and t.waiting_since < now() - interval '7 days'
     for update skip locked
  loop
    if public.support_close_ticket(v_ticket.id, 'auto', null) then
      v_closed := v_closed + 1;
    end if;
  end loop;

  for v_ticket in
    update public.support_tickets t
       set reminder_sent_at = now()
     where t.status = 'open' and t.waiting_on = 'user'
       and t.waiting_since < now() - interval '3 days'
       and t.reminder_sent_at is null
    returning t.id, t.notify_email
  loop
    insert into public.support_messages (ticket_id, author, kind, event)
    values (v_ticket.id, 'system', 'event', 'reminded');
    if v_ticket.notify_email then
      perform public.support_queue_notification(v_ticket.id, 'reminder');
    end if;
    v_reminded := v_reminded + 1;
  end loop;

  return query select v_reminded, v_closed;
end;
$$;

revoke all on function public.support_auto_close() from public, anon, authenticated;
grant execute on function public.support_auto_close() to service_role;

-- Leases due notifications for the sender (5 minutes, five tries).
create or replace function public.support_claim_notifications(p_limit integer)
returns setof public.support_notifications
language sql
security definer set search_path = ''
as $$
  update public.support_notifications n
     set locked_until = now() + interval '5 minutes',
         attempts = n.attempts + 1
   where n.id in (
     select x.id from public.support_notifications x
      where x.sent_at is null
        and x.due_at <= now()
        and x.attempts < 5
        and (x.locked_until is null or x.locked_until < now())
      order by x.due_at
      limit p_limit
      for update skip locked
   )
  returning n.*;
$$;

revoke all on function public.support_claim_notifications(integer) from public, anon, authenticated;
grant execute on function public.support_claim_notifications(integer) to service_role;

-- Signals the ticket's owner over Realtime: ids only, never notes.
create or replace function public.broadcast_support_message()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  select t.user_id into v_user from public.support_tickets t where t.id = new.ticket_id;
  if v_user is not null then
    perform realtime.send(
      jsonb_build_object('ticket_id', new.ticket_id),
      'support_ticket',
      'user:' || v_user::text,
      true
    );
  end if;
  return null;
end;
$$;

revoke all on function public.broadcast_support_message() from public, anon, authenticated;

drop trigger if exists support_messages_broadcast on public.support_messages;
create trigger support_messages_broadcast
  after insert on public.support_messages
  for each row
  when (new.kind <> 'note')
  execute function public.broadcast_support_message();

-- A deleted ticket's screenshots go with it. storage_deletions (00067)
-- only took request prefixes; it now takes t/{ticket_id}/ too.
alter table public.storage_deletions drop constraint if exists storage_deletions_prefix_check;
alter table public.storage_deletions
  add constraint storage_deletions_prefix_check check (prefix ~ '^[mt]/[0-9a-f-]{36}/$');

-- A deleted ticket's screenshots go with it.
create or replace function public.queue_support_objects_deletion()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.storage_deletions (prefix) values ('t/' || old.id::text || '/');
  return null;
end;
$$;

revoke all on function public.queue_support_objects_deletion() from public, anon, authenticated;

drop trigger if exists support_tickets_queue_objects_deletion on public.support_tickets;
create trigger support_tickets_queue_objects_deletion
  after delete on public.support_tickets
  for each row
  when (old.has_attachments)
  execute function public.queue_support_objects_deletion();


-- 2b. Two-factor sign-in in the database ------------------------------------
-- The web app refuses an aal1 session for an account with a verified
-- authenticator (lib/mfa.ts), but a browser token also reaches PostgREST and
-- Realtime directly. These restrictive policies hold client reads to the
-- same rule, so a stolen password alone reads nothing. The check is a
-- function called once per statement (wrapped in a select), not per row.
create or replace function public.session_mfa_ok()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select auth.uid() is null
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;

-- Policies run with the caller's rights, so client roles need EXECUTE.
revoke all on function public.session_mfa_ok() from public;
grant execute on function public.session_mfa_ok() to anon, authenticated, service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['users', 'endpoints', 'requests', 'api_keys', 'device_codes']
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_mfa', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for select to authenticated '
      'using ((select public.session_mfa_ok()))',
      v_table || '_mfa', v_table
    );
  end loop;
end;
$$;

-- Joining a private Realtime topic reads realtime.messages.
drop policy if exists webhooks_cc_topics_mfa on realtime.messages;
create policy webhooks_cc_topics_mfa on realtime.messages
  as restrictive for select to authenticated
  using ((select public.session_mfa_ok()));


-- 3. Ops metrics -------------------------------------------------------------

create table if not exists public.ops_daily_metrics (
  day                      date primary key,
  signups                  integer not null default 0,
  -- Accounts that signed up 7 days earlier, and how many of them captured
  -- something within their first 7 days.
  cohort_signups           integer,
  cohort_activated         integer,
  active_accounts          integer not null default 0,
  captured                 bigint not null default 0,
  quota_rejected           bigint not null default 0,
  -- Snapshot of paying accounts (personal and team) at the end of the day;
  -- null for days before snapshots began.
  paid_accounts            integer,
  new_paid                 integer,
  lost_paid                integer,
  -- From Polar's metrics, filled in by the web app.
  mrr_cents                bigint,
  new_subscriptions        integer,
  canceled_subscriptions   integer,
  computed_at              timestamptz not null default now()
);

alter table public.ops_daily_metrics enable row level security;
revoke all on table public.ops_daily_metrics from public, anon, authenticated;
grant select, insert, update, delete on table public.ops_daily_metrics to service_role;

create table if not exists public.ops_paid_accounts (
  day     date not null,
  account text not null,
  primary key (day, account)
);

alter table public.ops_paid_accounts enable row level security;
revoke all on table public.ops_paid_accounts from public, anon, authenticated;
grant select, insert, delete on table public.ops_paid_accounts to service_role;

-- Accounts left out of every metric: staff and internal (test) accounts.
create or replace function public.ops_excluded_users()
returns table (user_id uuid)
language sql
stable
security definer set search_path = ''
as $$
  select s.user_id from public.staff s
  union
  select u.id from public.users u where u.internal;
$$;

revoke all on function public.ops_excluded_users() from public, anon, authenticated;
grant execute on function public.ops_excluded_users() to service_role;

-- Writes (or rewrites) one UTC day. p_snapshot also records the paying
-- accounts as they are now, which is only right for the day just ended.
create or replace function public.ops_rollup_day(p_day date, p_snapshot boolean default false)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_start   timestamptz := p_day::timestamp at time zone 'UTC';
  v_end     timestamptz := (p_day + 1)::timestamp at time zone 'UTC';
  v_cohort  date := p_day - 7;
  v_signups integer;
  v_cohort_signups integer;
  v_cohort_activated integer;
  v_active integer;
  v_captured bigint;
  v_rejected bigint;
  v_paid integer;
  v_new integer;
  v_lost integer;
begin
  select count(*) into v_signups
    from public.users u
   where u.created_at >= v_start and u.created_at < v_end
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  select count(*),
         count(*) filter (where exists (
           select 1 from public.endpoint_daily_stats s
            where s.user_id = u.id
              and s.day between (u.created_at at time zone 'UTC')::date
                            and (u.created_at at time zone 'UTC')::date + 6
              and s.captured > 0
         ))
    into v_cohort_signups, v_cohort_activated
    from public.users u
   where u.created_at >= v_cohort::timestamp at time zone 'UTC'
     and u.created_at < (v_cohort + 1)::timestamp at time zone 'UTC'
     and u.id not in (select x.user_id from public.ops_excluded_users() x);

  select count(distinct s.user_id) filter (where s.captured > 0),
         coalesce(sum(s.captured), 0),
         coalesce(sum(s.quota_rejected), 0)
    into v_active, v_captured, v_rejected
    from public.endpoint_daily_stats s
   where s.day = p_day
     and (s.user_id is null
          or s.user_id not in (select x.user_id from public.ops_excluded_users() x));

  if p_snapshot then
    delete from public.ops_paid_accounts where day = p_day;
    insert into public.ops_paid_accounts (day, account)
    select p_day, 'u:' || u.id::text
      from public.users u
     where u.plan <> 'free' and u.polar_subscription_id is not null
       and u.id not in (select x.user_id from public.ops_excluded_users() x)
    union
    select p_day, 't:' || t.id::text
      from public.teams t
     where t.subscription_status is not null
       and t.created_by not in (select x.user_id from public.ops_excluded_users() x)
    on conflict do nothing;
  end if;

  if exists (select 1 from public.ops_paid_accounts p where p.day = p_day) then
    select count(*) into v_paid from public.ops_paid_accounts p where p.day = p_day;
    if exists (select 1 from public.ops_paid_accounts p where p.day = p_day - 1) then
      select count(*) into v_new
        from public.ops_paid_accounts p
       where p.day = p_day
         and not exists (select 1 from public.ops_paid_accounts q
                          where q.day = p_day - 1 and q.account = p.account);
      select count(*) into v_lost
        from public.ops_paid_accounts p
       where p.day = p_day - 1
         and not exists (select 1 from public.ops_paid_accounts q
                          where q.day = p_day and q.account = p.account);
    end if;
  end if;

  insert into public.ops_daily_metrics as m (
    day, signups, cohort_signups, cohort_activated, active_accounts, captured,
    quota_rejected, paid_accounts, new_paid, lost_paid, computed_at
  ) values (
    p_day, v_signups, v_cohort_signups, v_cohort_activated, coalesce(v_active, 0),
    v_captured, v_rejected, v_paid, v_new, v_lost, now()
  )
  on conflict (day) do update set
    signups = excluded.signups,
    cohort_signups = excluded.cohort_signups,
    cohort_activated = excluded.cohort_activated,
    active_accounts = excluded.active_accounts,
    captured = excluded.captured,
    quota_rejected = excluded.quota_rejected,
    paid_accounts = coalesce(excluded.paid_accounts, m.paid_accounts),
    new_paid = coalesce(excluded.new_paid, m.new_paid),
    lost_paid = coalesce(excluded.lost_paid, m.lost_paid),
    computed_at = now();
end;
$$;

revoke all on function public.ops_rollup_day(date, boolean) from public, anon, authenticated;
grant execute on function public.ops_rollup_day(date, boolean) to service_role;

-- Today so far, cheap enough for every page load: small tables and the
-- per-day index on endpoint_daily_stats.
create or replace function public.ops_today()
returns table (signups bigint, captured bigint, active_accounts bigint)
language sql
stable
security definer set search_path = ''
as $$
  select
    (select count(*) from public.users u
      where u.created_at >= (now() at time zone 'UTC')::date::timestamp at time zone 'UTC'
        and u.id not in (select x.user_id from public.ops_excluded_users() x)),
    (select coalesce(sum(s.captured), 0)::bigint from public.endpoint_daily_stats s
      where s.day = (now() at time zone 'UTC')::date
        and (s.user_id is null
             or s.user_id not in (select x.user_id from public.ops_excluded_users() x))),
    (select count(distinct s.user_id) from public.endpoint_daily_stats s
      where s.day = (now() at time zone 'UTC')::date and s.captured > 0
        and s.user_id not in (select x.user_id from public.ops_excluded_users() x));
$$;

revoke all on function public.ops_today() from public, anon, authenticated;
grant execute on function public.ops_today() to service_role;


-- 4. Jobs --------------------------------------------------------------------

select cron.unschedule(jobid) from cron.job where jobname = 'support-auto-close';
select cron.schedule(
  'support-auto-close',
  '17 * * * *',
  $$select public.support_auto_close()$$
);

notify pgrst, 'reload schema';
