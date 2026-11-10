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

/**
 * A navigation that is on its way (the router is still fetching the page).
 * Next treats a history.replaceState made meanwhile as a navigation of its
 * own, which cancels the one in flight, so the dashboard holds back the URL
 * writes nobody asked for (following live requests) until it has landed.
 */
const NAVIGATION_GIVE_UP_MS = 10_000;
let navigationStartedAt: number | null = null;

/** Call right before router.push or router.replace to another page or endpoint. */
export function noteNavigation(): void {
  navigationStartedAt = Date.now();
}

/** The navigation landed (the page saw its URL change) or its page went away. */
export function navigationSettled(): void {
  navigationStartedAt = null;
}

/** Whether a navigation noted above is still on its way; one that never lands stops counting. */
export function navigationPending(): boolean {
  if (navigationStartedAt === null) return false;
  if (Date.now() - navigationStartedAt < NAVIGATION_GIVE_UP_MS) return true;
  navigationStartedAt = null;
  return false;
}
