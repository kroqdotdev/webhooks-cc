import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Handler = (message: { event: string }) => void;

class FakeChannel {
  handler: Handler | null = null;
  subscribed = 0;
  tornDown = false;
  constructor(readonly topic: string) {}
  on(_type: string, _filter: unknown, handler: Handler) {
    this.handler = handler;
    return this;
  }
  subscribe() {
    this.subscribed++;
    return this;
  }
  teardown() {
    this.tornDown = true;
  }
  emit(event: string) {
    this.handler?.({ event });
  }
}

const fake = vi.hoisted(() => ({
  channels: [] as unknown[],
  removals: [] as Array<{ channel: unknown; resolve: (status: string) => void }>,
}));

vi.mock("./client", () => ({
  createClient: () => ({
    channel: (topic: string) => {
      const channel = new FakeChannel(topic);
      fake.channels.push(channel);
      return channel;
    },
    removeChannel: (channel: unknown) =>
      new Promise<string>((resolve) => fake.removals.push({ channel, resolve })),
  }),
}));

async function load() {
  vi.resetModules();
  return import("./realtime");
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("realtime topic registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.channels.length = 0;
    fake.removals.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("listeners on one topic share a private channel", async () => {
    const { subscribeToEndpointRequestChanges } = await load();
    const first = vi.fn();
    const second = vi.fn();
    subscribeToEndpointRequestChanges("e1", first);
    subscribeToEndpointRequestChanges("e1", second);
    await flush();

    expect(fake.channels).toHaveLength(1);
    const channel = fake.channels[0] as FakeChannel;
    expect(channel.topic).toBe("endpoint:e1");
    channel.emit("request_created");
    channel.emit("endpoint_deleted");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("a resubscribe within the linger window reuses the channel", async () => {
    const { subscribeToUserProfileChanges } = await load();
    const unsubscribe = subscribeToUserProfileChanges("u1", vi.fn());
    await flush();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    subscribeToUserProfileChanges("u1", vi.fn());
    await vi.advanceTimersByTimeAsync(2000);

    expect(fake.channels).toHaveLength(1);
    expect(fake.removals).toHaveLength(0);
  });

  test("a replacement waits for the previous channel's removal", async () => {
    const { subscribeToEndpointRequestChanges } = await load();
    const unsubscribe = subscribeToEndpointRequestChanges("e1", vi.fn());
    await flush();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.removals).toHaveLength(1);

    const listener = vi.fn();
    subscribeToEndpointRequestChanges("e1", listener);
    await flush();
    expect(fake.channels).toHaveLength(1);

    fake.removals[0]!.resolve("ok");
    await flush();
    expect(fake.channels).toHaveLength(2);
    (fake.channels[1] as FakeChannel).emit("request_updated");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("tears the channel down when the leave is not acknowledged", async () => {
    const { subscribeToEndpointRequestChanges } = await load();
    const unsubscribe = subscribeToEndpointRequestChanges("e1", vi.fn());
    await flush();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);

    fake.removals[0]!.resolve("timed out");
    await flush();
    expect((fake.channels[0] as FakeChannel).tornDown).toBe(true);
  });
});
