import { MIN_REDIS_SECRET_BYTES } from "@collabdocs/shared/redis-auth";

/**
 * Refuses to run a deployment whose Redis messages cannot be trusted or delivered.
 * With REDIS_URL set the web app signs membership messages with REDIS_MESSAGE_SECRET;
 * without a usable secret the collab servers ignore them and a removed member keeps
 * their socket until the next periodic re-check, with nothing to say so. So a missing
 * or short secret, or one shared with another secret, stops the app at start.
 */
export function assertRuntimeConfig(env: Record<string, string | undefined> = process.env): void {
  if (!env.REDIS_URL) return;
  const secret = env.REDIS_MESSAGE_SECRET;
  if (!secret) throw new Error("REDIS_MESSAGE_SECRET is required when REDIS_URL is set");
  if (new TextEncoder().encode(secret).length < MIN_REDIS_SECRET_BYTES) {
    throw new Error(`REDIS_MESSAGE_SECRET must be at least ${MIN_REDIS_SECRET_BYTES} bytes`);
  }
  if (secret === env.COLLAB_TOKEN_SECRET) {
    throw new Error("REDIS_MESSAGE_SECRET must differ from COLLAB_TOKEN_SECRET");
  }
  if (secret === env.AUTH_SECRET) {
    throw new Error("REDIS_MESSAGE_SECRET must differ from AUTH_SECRET");
  }
}
