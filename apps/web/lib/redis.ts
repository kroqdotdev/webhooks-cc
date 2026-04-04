import Redis from "ioredis";

// Use globalThis to persist the Redis client across Next.js dev hot reloads.
// In production, module-level singletons work fine. In dev, Turbopack
// re-evaluates modules per request, losing module-level state.
const globalForRedis = globalThis as unknown as {
  __redisClient?: Redis | null;
  __redisInitialized?: boolean;
  __redisReady?: Promise<void>;
};

function createClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 100, 5000);
    },
  });

  redis.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  // Store a promise that resolves when the connection is ready (or fails)
  globalForRedis.__redisReady = new Promise<void>((resolve) => {
    redis.once("ready", resolve);
    redis.once("error", resolve);
    // Don't block forever if neither fires
    setTimeout(resolve, 2000);
  });

  return redis;
}

export function getRedisClient(): Redis | null {
  if (!globalForRedis.__redisInitialized) {
    globalForRedis.__redisInitialized = true;
    globalForRedis.__redisClient = createClient();
  }
  return globalForRedis.__redisClient ?? null;
}

/** Wait for Redis to be connected (or give up). Call once at startup. */
export async function waitForRedis(): Promise<void> {
  getRedisClient(); // ensure initialized
  if (globalForRedis.__redisReady) {
    await globalForRedis.__redisReady;
  }
}

export function isRedisAvailable(): boolean {
  const client = getRedisClient();
  return client !== null && client.status === "ready";
}
