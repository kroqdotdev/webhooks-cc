import Redis from "ioredis";

let client: Redis | null = null;
let connectionFailed = false;

function createClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 100, 5000);
    },
  });

  redis.on("error", () => {
    connectionFailed = true;
  });

  redis.on("ready", () => {
    connectionFailed = false;
  });

  redis.connect().catch(() => {
    connectionFailed = true;
  });

  return redis;
}

export function getRedisClient(): Redis | null {
  if (!client && !connectionFailed) {
    client = createClient();
  }
  return client;
}

export function isRedisAvailable(): boolean {
  return client !== null && client.status === "ready" && !connectionFailed;
}
