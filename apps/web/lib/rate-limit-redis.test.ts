import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Redis path of the rate limiter, with a fake client in place of ioredis.
const redisEval = vi.fn();
const reportError = vi.fn();

vi.mock("./redis", () => ({
  getRedisClient: () => ({ eval: redisEval }),
  isRedisAvailable: () => true,
}));

vi.mock("@/lib/observability", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

async function loadRateLimit() {
  vi.resetModules();
  return import("./rate-limit");
}

/** Blocks the event loop, like a long synchronous render or a GC pause. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A connected pair of TCP sockets on loopback. */
async function socketPair(): Promise<{
  client: net.Socket;
  server: net.Socket;
  close: () => void;
}> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as net.AddressInfo;
  const accepted = new Promise<net.Socket>((resolve) => listener.once("connection", resolve));
  const client = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const server = await accepted;
  return {
    client,
    server,
    close: () => {
      client.destroy();
      server.destroy();
      listener.close();
    },
  };
}

beforeEach(() => {
  redisEval.mockReset();
  reportError.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Redis rate limit", () => {
  it("uses a reply that arrived while the event loop was busy past the timeout", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    const pair = await socketPair();
    try {
      // Redis answers at once: the reply is in the socket before the event
      // loop gets back to reading it. Count 2 before this request, of max 5.
      redisEval.mockImplementation(() => {
        const reply = new Promise((resolve) =>
          pair.client.once("data", () => resolve([2, Date.now()]))
        );
        pair.server.write("+OK\r\n");
        return reply;
      });

      const pending = checkRateLimitByKeyWithInfo("stall-test", 5);
      blockEventLoop(250);
      const info = await pending;

      expect(info.allowed).toBe(true);
      expect(info.remaining).toBe(2); // Redis's count, not the in-memory limit's 4
      expect(reportError).not.toHaveBeenCalled();
    } finally {
      pair.close();
    }
  });

  it("falls back on a single timeout without reporting an error", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    redisEval.mockImplementation(() => new Promise(() => {}));

    const info = await checkRateLimitByKeyWithInfo("timeout-test", 5);

    expect(info.allowed).toBe(true);
    expect(info.remaining).toBe(4); // the in-memory limit answered
    expect(reportError).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("reports Redis once timeouts keep coming in a row", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    redisEval.mockImplementation(() => new Promise(() => {}));

    for (let i = 0; i < 4; i++) await checkRateLimitByKeyWithInfo("repeat-test", 100);
    expect(reportError).not.toHaveBeenCalled();

    await checkRateLimitByKeyWithInfo("repeat-test", 100);
    expect(reportError).toHaveBeenCalledWith(
      "[rate-limit] Redis eval keeps timing out",
      expect.any(Error),
      { consecutive: 5 }
    );
  });

  it("starts counting timeouts again after an answer", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    const hang = () => new Promise(() => {});
    redisEval.mockImplementation(hang);
    for (let i = 0; i < 4; i++) await checkRateLimitByKeyWithInfo("reset-test", 100);

    redisEval.mockImplementationOnce(async () => [0, Date.now()]);
    await checkRateLimitByKeyWithInfo("reset-test", 100);

    for (let i = 0; i < 4; i++) await checkRateLimitByKeyWithInfo("reset-test", 100);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still reports an error from Redis itself", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    redisEval.mockRejectedValue(new Error("NOSCRIPT"));

    const info = await checkRateLimitByKeyWithInfo("error-test", 5);

    expect(info.allowed).toBe(true);
    expect(reportError).toHaveBeenCalledWith("[rate-limit] Redis eval failed", expect.any(Error));
  });

  it("clears its timer when Redis answers in time", async () => {
    const { checkRateLimitByKeyWithInfo } = await loadRateLimit();
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    redisEval.mockImplementation(async () => [0, Date.now()]);

    await checkRateLimitByKeyWithInfo("timer-test", 5);

    expect(clearTimeout).toHaveBeenCalled();
  });
});
