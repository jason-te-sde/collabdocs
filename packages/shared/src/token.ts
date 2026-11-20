import { SignJWT, jwtVerify, errors } from "jose";
import { isRole, type Role } from "./permissions";

export const COLLAB_TOKEN_ISSUER = "collabdocs-web";
export const COLLAB_TOKEN_AUDIENCE = "collabdocs-collab";
export const MIN_SECRET_BYTES = 32;
export const DEFAULT_TTL_SECONDS = 300;
export const MAX_TTL_SECONDS = 900;

export interface CollabClaims {
  documentId: string;
  userId: string;
  role: Role;
}

export interface SignedCollabToken {
  token: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

export type CollabTokenFailure =
  "malformed" | "bad-signature" | "expired" | "wrong-document" | "bad-claims";

export class CollabTokenError extends Error {
  readonly reason: CollabTokenFailure;
  constructor(reason: CollabTokenFailure) {
    super(`invalid collaboration token: ${reason}`);
    this.name = "CollabTokenError";
    this.reason = reason;
  }
}

function key(secret: string): Uint8Array {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(`the collaboration token secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return bytes;
}

export interface SignOptions extends CollabClaims {
  secret: string;
  /** Lifetime in seconds. Defaults to 5 minutes and is capped at 15. */
  ttlSeconds?: number;
  /** Unix time in seconds; for tests. */
  now?: number;
}

/** Signs a short-lived token that lets one user open one document with one role. */
export async function signCollabToken(options: SignOptions): Promise<SignedCollabToken> {
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}`);
  }
  const issuedAt = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttl;
  const token = await new SignJWT({ doc: options.documentId, role: options.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(COLLAB_TOKEN_ISSUER)
    .setAudience(COLLAB_TOKEN_AUDIENCE)
    .setSubject(options.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key(options.secret));
  return { token, expiresAt };
}

export interface VerifyOptions {
  token: string;
  secret: string;
  /** The document the connection asks for. The token must be for this document. */
  documentId: string;
  /** Unix time in seconds; for tests. */
  now?: number;
}

/**
 * Checks signature, issuer, audience and expiry, then that the token is for
 * `documentId`. Throws CollabTokenError; never returns claims it did not check.
 */
export async function verifyCollabToken(options: VerifyOptions): Promise<CollabClaims> {
  let payload;
  try {
    const result = await jwtVerify(options.token, key(options.secret), {
      algorithms: ["HS256"],
      issuer: COLLAB_TOKEN_ISSUER,
      audience: COLLAB_TOKEN_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
      ...(options.now === undefined ? {} : { currentDate: new Date(options.now * 1000) }),
    });
    payload = result.payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new CollabTokenError("expired");
    if (error instanceof errors.JWSSignatureVerificationFailed)
      throw new CollabTokenError("bad-signature");
    if (error instanceof errors.JWTClaimValidationFailed) throw new CollabTokenError("bad-claims");
    if (error instanceof Error && error.message.startsWith("the collaboration token secret"))
      throw error;
    throw new CollabTokenError("malformed");
  }
  const { doc, role, sub } = payload as { doc?: unknown; role?: unknown; sub?: string };
  if (typeof doc !== "string" || !isRole(role) || typeof sub !== "string" || sub === "") {
    throw new CollabTokenError("bad-claims");
  }
  if (doc !== options.documentId) throw new CollabTokenError("wrong-document");
  return { documentId: doc, userId: sub, role };
}
