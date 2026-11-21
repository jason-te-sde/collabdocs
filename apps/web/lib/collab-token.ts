import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_SECRET_BYTES } from "@collabdocs/shared";

export interface CollabTokenConfig {
  secret: string;
  ttlSeconds: number;
}

/** Reads the signing secret and lifetime from the environment, and refuses a weak setup. */
export function collabTokenConfig(
  env: Record<string, string | undefined> = process.env,
): CollabTokenConfig {
  const secret = env.COLLAB_TOKEN_SECRET;
  if (!secret || new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(`COLLAB_TOKEN_SECRET must be set to at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (secret === env.AUTH_SECRET) {
    throw new Error("COLLAB_TOKEN_SECRET must differ from AUTH_SECRET");
  }
  const raw = env.COLLAB_TOKEN_TTL_SECONDS;
  const ttlSeconds = raw === undefined || raw === "" ? DEFAULT_TTL_SECONDS : Number(raw);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`COLLAB_TOKEN_TTL_SECONDS must be an integer from 1 to ${MAX_TTL_SECONDS}`);
  }
  return { secret, ttlSeconds };
}
