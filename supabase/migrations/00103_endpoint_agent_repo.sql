-- The GitHub repository a coding agent should fix a failed delivery in
-- (`owner/name`), set by the endpoint's owner. With it, delivery-failure
-- alert emails carry an "Open in T3 Code" link for that repository; the
-- dashboard's Copy prompt works without it. Null means none.
--
-- The check mirrors isAgentRepo() in apps/web/lib/fix-prompt.ts: GitHub's
-- own rules for an owner (letters, digits and dashes, not starting with a
-- dash, at most 39) and a repository name (letters, digits, dots, dashes
-- and underscores, at most 100, not only dots). Added NOT VALID and then
-- validated, so the table is scanned under a lock that lets reads and
-- writes go on; every row is null when it runs.

alter table public.endpoints
  add column if not exists agent_repo text;

comment on column public.endpoints.agent_repo is
  'GitHub owner/name a coding agent fixes failed deliveries in (fix prompts); null for none.';

alter table public.endpoints
  drop constraint if exists endpoints_agent_repo_check,
  add constraint endpoints_agent_repo_check
    check (
      agent_repo is null
      or (
        agent_repo ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
        and agent_repo !~* '(\.|\.git)$'
      )
    ) not valid;

alter table public.endpoints validate constraint endpoints_agent_repo_check;

notify pgrst, 'reload schema';
