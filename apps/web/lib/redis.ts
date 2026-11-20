import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { collabdocsRedis?: Redis };

/**
 * The web app's shared Redis client, or null when REDIS_URL is not set. Created on
 * first use. A Redis outage must not crash the app: errors are swallowed here and
 * reported by each call, which has its own fallback.
 */
export function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalForRedis.collabdocsRedis) {
    const client = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
    client.on("error", () => {});
    globalForRedis.collabdocsRedis = client;
  }
  return globalForRedis.collabdocsRedis;
}
