-- 00054: agents in the audit trail.
--
-- Agent registration (auth.md) creates API keys, and through the email flow
-- accounts, without a signed-in user, so its events have no user to record as
-- the actor. audit_events gains actor_type 'agent' for them, and via
-- 'agent_token' for claimed agents acting through the normal routes (from the
-- auth.md v0.6 work on).
--
-- The checks are swapped inside one transaction so the table is never without
-- them, added NOT VALID and validated afterwards (the table is small; this
-- keeps the pattern of the other constraint changes).

begin;

alter table public.audit_events drop constraint audit_events_actor_type_check;
alter table public.audit_events
  add constraint audit_events_actor_type_check
  check (actor_type in ('user', 'polar', 'system', 'agent')) not valid;

alter table public.audit_events drop constraint audit_events_via_check;
alter table public.audit_events
  add constraint audit_events_via_check
  check (via in ('session', 'api_key', 'agent_token')) not valid;

commit;

alter table public.audit_events validate constraint audit_events_actor_type_check;
alter table public.audit_events validate constraint audit_events_via_check;
