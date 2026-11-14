/**
 * Caps how many request searches run at once, per account and for the
 * process.
 *
 * A search reads rows until its time budget is spent (see
 * search_requests_page(), migration 00098), so each one may hold a database
 * connection and a core for that long. The box has four cores and captures
 * must always keep one, so the process runs at most three searches, and one
 * account at most two (a dashboard tab and an agent). A search that finds no
 * slot within a short wait is refused with a retry hint rather than queued
 * for good, because a client that waited longer would have given up anyway.
 *
 * The web app runs as one process; with several, this would move to Redis.
 */

export const SEARCH_MAX_RUNNING = 3;
export const SEARCH_MAX_RUNNING_PER_ACCOUNT = 2;
export const SEARCH_SLOT_WAIT_MS = 2_500;

export class SearchBusyError extends Error {
  readonly retryAfterSeconds = 2;

  constructor() {
    super("Too many searches are running; try again shortly.");
    this.name = "SearchBusyError";
  }
}

interface Waiter {
  accountId: string;
  grant: () => void;
}

interface GateState {
  running: number;
  perAccount: Map<string, number>;
  waiters: Waiter[];
}

const globalForGate = globalThis as typeof globalThis & {
  __webhooksSearchGate?: GateState;
};

function state(): GateState {
  globalForGate.__webhooksSearchGate ??= { running: 0, perAccount: new Map(), waiters: [] };
  return globalForGate.__webhooksSearchGate;
}

function canRun(gate: GateState, accountId: string): boolean {
  return (
    gate.running < SEARCH_MAX_RUNNING &&
    (gate.perAccount.get(accountId) ?? 0) < SEARCH_MAX_RUNNING_PER_ACCOUNT
  );
}

function take(gate: GateState, accountId: string): void {
  gate.running += 1;
  gate.perAccount.set(accountId, (gate.perAccount.get(accountId) ?? 0) + 1);
}

function release(gate: GateState, accountId: string): void {
  gate.running = Math.max(0, gate.running - 1);
  const left = (gate.perAccount.get(accountId) ?? 1) - 1;
  if (left > 0) gate.perAccount.set(accountId, left);
  else gate.perAccount.delete(accountId);

  // Wake the oldest waiters that may run now, in order.
  for (let i = 0; i < gate.waiters.length && gate.running < SEARCH_MAX_RUNNING;) {
    const waiter = gate.waiters[i];
    if (canRun(gate, waiter.accountId)) {
      gate.waiters.splice(i, 1);
      take(gate, waiter.accountId);
      waiter.grant();
    } else {
      i += 1;
    }
  }
}

/**
 * Runs `fn` once a slot is free for the account, waiting up to
 * `SEARCH_SLOT_WAIT_MS`; throws SearchBusyError when none frees in time.
 */
export async function withSearchSlot<T>(
  accountId: string,
  fn: () => Promise<T>,
  waitMs: number = SEARCH_SLOT_WAIT_MS
): Promise<T> {
  const gate = state();
  // Run at once unless an earlier waiter could take the slot (one held back
  // only by its own account's cap does not block other accounts).
  if (canRun(gate, accountId) && !gate.waiters.some((w) => canRun(gate, w.accountId))) {
    take(gate, accountId);
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        accountId,
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = gate.waiters.indexOf(waiter);
        if (index >= 0) gate.waiters.splice(index, 1);
        reject(new SearchBusyError());
      }, waitMs);
      gate.waiters.push(waiter);
    });
  }

  try {
    return await fn();
  } finally {
    release(gate, accountId);
  }
}

/** For tests: the gate as it stands. */
export function searchGateSnapshot(): { running: number; waiting: number } {
  const gate = state();
  return { running: gate.running, waiting: gate.waiters.length };
}
