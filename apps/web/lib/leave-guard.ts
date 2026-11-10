/**
 * Asks before a navigation that would drop unsaved work. The dashboard sets a
 * guard while endpoint settings hold unsaved edits; the header's menu (which
 * navigates with the router, not links) goes through it, so "Account" asks
 * the same question a link would. Without a guard the navigation just runs.
 */
type LeaveGuard = (proceed: () => void) => void;

let guard: LeaveGuard | null = null;

/** Set by the page that holds unsaved work; null when there is none. */
export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next;
}

/** Runs `proceed` now, or hands it to the guard to run once the person agrees. */
export function leaveThrough(proceed: () => void): void {
  if (guard) guard(proceed);
  else proceed();
}
