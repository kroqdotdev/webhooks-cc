-- ============================================================================
-- Migration 00043: live updates over Realtime Broadcast
--
-- Live updates used postgres_changes on requests, endpoints and users.
-- Realtime evaluates every change in the publication against every
-- subscriber's RLS inside Postgres, and each capture produced three changes
-- (the request insert plus the endpoint and user counter updates), so the
-- cost grew with changes times subscribers. Under load the replication slot
-- fell minutes behind and kept Postgres busy long after traffic stopped.
--
-- Triggers now send small signals with realtime.send() on private topics, and
-- clients re-read data through the authenticated routes they already use.
-- Authorization runs once per channel join instead of once per change:
--
--   endpoint:<endpoint id>  request_created, request_updated (signature
--                           verification result), endpoint_deleted
--   user:<user id>          profile_changed (plan, billing, quota state)
--
--  1. can_join_realtime_topic() decides who may join a topic: the user for
--     their own user topic, and the owner or a member of an active team the
--     endpoint is shared with for an endpoint topic. A policy on
--     realtime.messages calls it for authenticated clients. Clients get no
--     INSERT policy, so they cannot broadcast on these topics.
--
--  2. Triggers on requests, endpoints and users send the signals. Guest
--     (ephemeral) endpoints are skipped: nobody can join their topics.
--     The users trigger fires on profile and billing changes and when the
--     quota crosses its limit or resets, not on every capture, so a capture
--     sends one message.
--
--  3. requests, endpoints and users leave the supabase_realtime publication.
--
-- realtime.send() catches its own errors and only raises a warning, so a
-- broadcast problem cannot fail a capture.
--
-- Apply this right before deploying the web release that subscribes to the
-- broadcast topics: once the tables leave the publication, older dashboards
-- stop receiving live updates.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Topic authorization
-- ----------------------------------------------------------------------------

create or replace function public.can_join_realtime_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_endpoint_id uuid;
begin
  if v_uid is null or p_topic is null then
    return false;
  end if;

  if p_topic = 'user:' || v_uid::text then
    return true;
  end if;

  if p_topic !~ '^endpoint:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_endpoint_id := substr(p_topic, length('endpoint:') + 1)::uuid;

  return exists (
    select 1
      from public.endpoints e
     where e.id = v_endpoint_id
       and e.user_id = v_uid
  ) or public.can_view_team_endpoint(v_endpoint_id);
end;
$$;

-- The policy below runs as the joining role, so authenticated needs EXECUTE.
-- anon has no policy on realtime.messages and never reaches this function.
revoke all on function public.can_join_realtime_topic(text) from public;
revoke all on function public.can_join_realtime_topic(text) from anon;
grant execute on function public.can_join_realtime_topic(text) to authenticated, service_role;

drop policy if exists webhooks_cc_topics_read on realtime.messages;
create policy webhooks_cc_topics_read on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.can_join_realtime_topic((select realtime.topic()))
  );

-- ----------------------------------------------------------------------------
-- 2. Signals
-- ----------------------------------------------------------------------------

create or replace function public.broadcast_request_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('request_id', new.id),
    case tg_op when 'INSERT' then 'request_created' else 'request_updated' end,
    'endpoint:' || new.endpoint_id::text,
    true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_request_change() from public, anon, authenticated;

drop trigger if exists requests_broadcast_insert on public.requests;
create trigger requests_broadcast_insert
  after insert on public.requests
  for each row
  when (new.user_id is not null)
  execute function public.broadcast_request_change();

drop trigger if exists requests_broadcast_signature on public.requests;
create trigger requests_broadcast_signature
  after update of signature_verified, signature_error, signing_provider on public.requests
  for each row
  when (
    new.user_id is not null
    and (
      old.signature_verified is distinct from new.signature_verified
      or old.signature_error is distinct from new.signature_error
      or old.signing_provider is distinct from new.signing_provider
    )
  )
  execute function public.broadcast_request_change();

create or replace function public.broadcast_endpoint_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('endpoint_id', old.id),
    'endpoint_deleted',
    'endpoint:' || old.id::text,
    true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_endpoint_deleted() from public, anon, authenticated;

drop trigger if exists endpoints_broadcast_deleted on public.endpoints;
create trigger endpoints_broadcast_deleted
  after delete on public.endpoints
  for each row
  when (old.user_id is not null)
  execute function public.broadcast_endpoint_deleted();

create or replace function public.broadcast_profile_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('user_id', new.id),
    'profile_changed',
    'user:' || new.id::text,
    true
  );
  return null;
end;
$$;

revoke all on function public.broadcast_profile_changed() from public, anon, authenticated;

drop trigger if exists users_broadcast_profile on public.users;
create trigger users_broadcast_profile
  after update on public.users
  for each row
  when (
    old.plan is distinct from new.plan
    or old.request_limit is distinct from new.request_limit
    or old.period_end is distinct from new.period_end
    or old.cancel_at_period_end is distinct from new.cancel_at_period_end
    or old.subscription_status is distinct from new.subscription_status
    or old.name is distinct from new.name
    or old.email is distinct from new.email
    or old.image is distinct from new.image
    or new.requests_used < old.requests_used
    or (old.requests_used >= old.request_limit) is distinct from (new.requests_used >= new.request_limit)
  )
  execute function public.broadcast_profile_changed();

-- ----------------------------------------------------------------------------
-- 3. Leave the postgres_changes publication
-- ----------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['requests', 'endpoints', 'users'] loop
    if exists (
      select 1
        from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', v_table);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
