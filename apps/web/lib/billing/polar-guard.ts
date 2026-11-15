import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A check every mutating Polar call makes first, while one is set: a
 * billing change approved by the owner (runBillingChange) makes sure it
 * still holds its account's lease, with time left, before Polar is asked to
 * change or charge anything. Throwing stops the call before it reaches
 * Polar.
 */
export interface PolarMutationGuard {
  beforeMutation(call: string): Promise<void>;
}

/** The longest a Polar call can take: the client's 30 second timeout (lib/polar.ts), and a margin. */
export const POLAR_CALL_MS = 35_000;

const guards = new AsyncLocalStorage<PolarMutationGuard>();

/** Runs `fn` with `guard` checked before each mutating Polar call it makes. */
export function withPolarMutationGuard<T>(
  guard: PolarMutationGuard,
  fn: () => Promise<T>
): Promise<T> {
  return guards.run(guard, fn);
}

/** The guard set for the code running now, if any. */
export function currentPolarMutationGuard(): PolarMutationGuard | undefined {
  return guards.getStore();
}

/**
 * Whether a Polar SDK method only reads, by its name: `get`, and the
 * `list` and `iterList` families. Everything else (update, create, revoke,
 * assignSeat, ingest) counts as a change, so a method added later is
 * guarded unless it reads.
 */
export function isReadOnlyPolarMethod(name: string): boolean {
  return name === "get" || /^(list|iterList)/.test(name);
}

/**
 * The client with each mutating method of its resources (`client.x.y()`)
 * checking the guard that is set when it is called. Methods are called on
 * the real objects, never the proxies, so the SDK's own `this` holds.
 */
export function guardPolarClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value === "function") return value.bind(target);
      if (typeof prop !== "string" || value === null || typeof value !== "object") return value;
      return guardResource(value, prop);
    },
  });
}

function guardResource(resource: object, resourceName: string): object {
  return new Proxy(resource, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof prop !== "string" || isReadOnlyPolarMethod(prop)) return method.bind(target);
      return async (...args: unknown[]) => {
        await guards.getStore()?.beforeMutation(`${resourceName}.${prop}`);
        return method.apply(target, args);
      };
    },
  });
}
