import { describe, expect, test, vi } from "vitest";
import {
  currentPolarMutationGuard,
  guardPolarClient,
  isReadOnlyPolarMethod,
  withPolarMutationGuard,
} from "./polar-guard";

/** A resource whose methods need their own `this`, as the SDK's do. */
class FakeSubscriptions {
  #calls: string[] = [];
  async get(id: string) {
    this.#calls.push(`get ${id}`);
    return { id };
  }
  async update(id: string) {
    this.#calls.push(`update ${id}`);
    return { id, updated: true };
  }
  calls() {
    return this.#calls;
  }
}

function fakeClient() {
  return { subscriptions: new FakeSubscriptions() };
}

describe("the Polar mutation guard", () => {
  test("checks the guard before a mutating call, and lets reads through", async () => {
    const order: string[] = [];
    const guard = {
      beforeMutation: vi.fn(async (call: string) => {
        order.push(`guard ${call}`);
      }),
    };
    const raw = fakeClient();
    await withPolarMutationGuard(guard, async () => {
      const client = guardPolarClient(raw);
      await client.subscriptions.get("sub_1");
      await client.subscriptions.update("sub_1");
    });
    expect(guard.beforeMutation).toHaveBeenCalledTimes(1);
    expect(guard.beforeMutation).toHaveBeenCalledWith("subscriptions.update");
    expect(raw.subscriptions.calls()).toEqual(["get sub_1", "update sub_1"]);
    expect(order).toEqual(["guard subscriptions.update"]);
  });

  test("a guard that throws stops the call before it reaches Polar", async () => {
    const raw = fakeClient();
    const guard = {
      beforeMutation: async () => {
        throw new Error("lease lost");
      },
    };
    await expect(
      withPolarMutationGuard(guard, () => guardPolarClient(raw).subscriptions.update("sub_1"))
    ).rejects.toThrow("lease lost");
    expect(raw.subscriptions.calls()).toEqual([]);
  });

  test("without a guard set, calls go straight through", async () => {
    expect(currentPolarMutationGuard()).toBeUndefined();
    const raw = fakeClient();
    await expect(guardPolarClient(raw).subscriptions.update("sub_1")).resolves.toEqual({
      id: "sub_1",
      updated: true,
    });
  });

  test("only get and the list families count as reads", () => {
    for (const name of ["get", "list", "listSeats", "iterList"]) {
      expect(isReadOnlyPolarMethod(name)).toBe(true);
    }
    for (const name of ["update", "create", "revoke", "assignSeat", "revokeSeat", "ingest"]) {
      expect(isReadOnlyPolarMethod(name)).toBe(false);
    }
  });
});
