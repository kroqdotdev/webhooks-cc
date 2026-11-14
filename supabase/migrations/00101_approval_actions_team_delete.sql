-- Deleting a team with an API key or agent token waits for the owner's
-- approval (lib/approvals/actions.ts): it ends the team's subscription at
-- once and cannot be undone. One statement drops and adds the check, so a
-- lock timeout leaves the old check in place, never none.

alter table public.approvals
  drop constraint if exists approvals_action_check,
  add constraint approvals_action_check
    check (action in (
      'api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename',
      'google.connect', 'google.pick', 'ai.assist', 'teams.delete'
    ));

notify pgrst, 'reload schema';
