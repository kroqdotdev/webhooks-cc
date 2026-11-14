-- A billing change asked for with an API key or agent token (a plan, its
-- interval, seats, add-on units, the overage maximum, cancelling or keeping
-- the subscription) waits for the owner's approval (billing.change in
-- lib/approvals/actions.ts): it can charge the account's card. The quote is
-- kept in params, and the change runs only while a fresh quote still
-- matches it. One statement drops and adds the check, so a lock timeout
-- leaves the old check in place, never none.

alter table public.approvals
  drop constraint if exists approvals_action_check,
  add constraint approvals_action_check
    check (action in (
      'api_keys.create', 'request_shares.create', 'domains.remove', 'account.rename',
      'google.connect', 'google.pick', 'ai.assist', 'teams.delete', 'teams.invite',
      'billing.change'
    ));

notify pgrst, 'reload schema';
