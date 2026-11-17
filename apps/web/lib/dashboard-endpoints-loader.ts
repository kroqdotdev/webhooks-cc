import type { DashboardEndpointsResponse } from "./dashboard-api";

/** The dashboard's endpoint list, kept with the account it belongs to. */
export interface DashboardEndpointsState {
  userId: string;
  /** Undefined until a load succeeds. */
  data?: DashboardEndpointsResponse;
  /** The first load failed and nothing is listed yet. */
  failed: boolean;
}

type StateUpdate = (prev: DashboardEndpointsState | null) => DashboardEndpointsState | null;

/**
 * Loads the dashboard's endpoint list (components/dashboard/endpoints-provider.tsx),
 * apart from React so the orderings can be tested:
 *
 * - Every load waits for the guest claim, not only the first. An empty list
 *   makes the dashboard create an endpoint of its own, so a load that listed
 *   before the claim landed would leave a new account with two.
 * - A list never replaces a newer one: every star click starts a reload, and
 *   an older one may answer last with the favourites from before it. An
 *   older list still counts when nothing newer has arrived (the newest load
 *   may fail), but a failure counts only from the newest load.
 * - A failed load keeps the list it had. With none yet, it reports a failure
 *   rather than an empty list, which is the first-endpoint screen.
 * - reload() settles with the newest load, so a caller that waits on it never
 *   reads a list older than one asked for after it, and answers whether that
 *   load succeeded.
 */
export function createEndpointsLoader(deps: {
  /** Claims a guest endpoint made before signing up; never rejects. */
  claim: (accessToken: string) => Promise<void>;
  fetchList: (accessToken: string) => Promise<DashboardEndpointsResponse>;
  setState: (update: StateUpdate) => void;
  onError?: (error: unknown) => void;
}) {
  let claim: { userId: string; done: Promise<void> } | null = null;
  let seq = 0;
  // The newest load whose list is on screen, and whose account loads now.
  let applied = 0;
  let currentUser: string | null = null;
  let latest: Promise<boolean> = Promise.resolve(false);

  async function load(accessToken: string, userId: string): Promise<boolean> {
    const mine = ++seq;
    currentUser = userId;
    if (claim?.userId !== userId) {
      claim = { userId, done: deps.claim(accessToken).catch(() => {}) };
    }
    await claim.done;
    try {
      const data = await deps.fetchList(accessToken);
      if (mine > applied && userId === currentUser) {
        applied = mine;
        deps.setState(() => ({ userId, data, failed: false }));
      }
      return true;
    } catch (error) {
      deps.onError?.(error);
      if (mine === seq) {
        deps.setState((prev) =>
          prev?.userId === userId && prev.data ? prev : { userId, failed: true }
        );
      }
      return false;
    }
  }

  return {
    async reload(accessToken: string, userId: string): Promise<boolean> {
      const run = load(accessToken, userId);
      latest = run;
      let waited = run;
      let ok = await waited;
      // A newer load started meanwhile: settle with that one.
      while (latest !== waited) {
        waited = latest;
        ok = await waited;
      }
      return ok;
    },
  };
}
