-- More actions an agent or API key may ask the account's owner for
-- (lib/approvals/actions.ts): a share link, removing an inbound domain, and
-- renaming the account. The table holds at most a few rows per account and
-- is cleaned a day after they expire, so the check is replaced in one step.

alter table public.approvals drop constraint if exists approvals_action_check;
alter table public.approvals
  add constraint approvals_action_check
  check (action in ('api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename'));

notify pgrst, 'reload schema';
