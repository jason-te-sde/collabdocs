import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

/** Hashes with argon2id and the library's default parameters (19 MiB, 2 passes, 1 lane). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. When there is no stored hash (an unknown user, or a user
 * who only signs in with GitHub) it still does the same amount of work, so that
 * the response time does not tell whether the email is registered.
 */
export async function verifyPassword(stored: string | null | undefined, password: string) {
  if (!stored) {
    dummyHash ??= hash("collabdocs-timing-equaliser");
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}
