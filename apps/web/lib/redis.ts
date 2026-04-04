import Redis from "ioredis";

// Use globalThis to persist the Redis client across Next.js dev hot reloads.
// In production, module-level singletons work fine. In dev, Turbopack
// re-evaluates modules per request, losing module-level state.
const globalForRedis = globalThis as unknown as {
  __redisClient?: Redis | null;
  __redisInitialized?: boolean;
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

  return redis;
}

export function getRedisClient(): Redis | null {
  if (!globalForRedis.__redisInitialized) {
    globalForRedis.__redisInitialized = true;
    globalForRedis.__redisClient = createClient();
  }
  return globalForRedis.__redisClient ?? null;
}

export function isRedisAvailable(): boolean {
  const client = getRedisClient();
  return client !== null && client.status === "ready";
}
