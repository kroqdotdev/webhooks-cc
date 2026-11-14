-- More actions an agent or API key may ask the account's owner for
-- (lib/approvals/actions.ts): connecting a Google account and choosing a
-- spreadsheet from Drive for Sheets destinations, and AI setup, which sends
-- picked emails to the model. One statement drops and adds the check, so a
-- lock timeout leaves the old check in place, never none.

alter table public.approvals
  drop constraint if exists approvals_action_check,
  add constraint approvals_action_check
    check (action in (
      'api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename',
      'google.connect', 'google.pick', 'ai.assist'
    ));

notify pgrst, 'reload schema';
