-- 00081: Business and Team Business get 250 AI assists in a rolling 30 days,
-- down from 500 (00067). take_ai_assist() and ai_assists_left() (00075) read
-- plan_entitlements.ai_assists on every ask, so the new number counts at once;
-- uses already made in the window still count against it.
--
-- lib/entitlements.ts mirrors this row; the entitlements integration test
-- compares the two.
--
-- Re-runnable.

update public.plan_entitlements
   set ai_assists = 250
 where key in ('business', 'team_business')
   and ai_assists is distinct from 250;
