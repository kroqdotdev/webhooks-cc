import { AsyncLocalStorage } from "node:async_hooks";

const timeouts = new AsyncLocalStorage<number>();

/**
 * Runs `fn` with every call the admin client makes (lib/supabase/admin.ts)
 * cut off after `ms`: such a call then answers an error, as any failed
 * request does. A billing change an owner approved runs under one, so a
 * hung database request cannot keep a run going past its lease, where the
 * asker's poll would read it as over.
 */
export function withSupabaseCallTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return timeouts.run(ms, fn);
}

/** The fetch the admin client uses: the platform's, with the timeout set for the code running now. */
export const timedFetch: typeof fetch = (input, init) => {
  const ms = timeouts.getStore();
  if (ms === undefined) return fetch(input, init);
  const timeout = AbortSignal.timeout(ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};
