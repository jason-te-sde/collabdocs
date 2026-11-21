/**
 * Message authentication for the Redis channels. Redis is shared infrastructure;
 * a message is acted on only if it carries an HMAC made with REDIS_MESSAGE_SECRET,
 * which only the web app and the collab servers hold. This module uses Node's
 * crypto, so import it only on the server, through its own subpath.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  encodeMembershipChange,
  parseMembershipChange,
  type MembershipChange,
} from "./collab-protocol";

export const MIN_REDIS_SECRET_BYTES = 32;
/** How old a signed message may be when it arrives. Bounds a replay of a captured one. */
export const MEMBERSHIP_MAX_AGE_MS = 120_000;
/** How far in the future a signed message's timestamp may be (clock skew). */
const MAX_SKEW_MS = 30_000;

/** True when a message issued at `issued` (ms since the epoch) is fresh enough at `now`. */
export function issuedWithinWindow(issued: number, now: number = Date.now()): boolean {
  return issued >= now - MEMBERSHIP_MAX_AGE_MS && issued <= now + MAX_SKEW_MS;
}

export const MAC_BYTES = 32;

/**
 * HMAC-SHA256 over `data`, keyed by `secret` and bound to a purpose, so that a
 * tag made for one channel is worthless on the other.
 */
export function messageMac(
  secret: string,
  purpose: "relay" | "membership",
  data: Uint8Array | string,
): Buffer {
  return createHmac("sha256", secret).update(`${purpose}\0`).update(data).digest();
}

export function macMatches(expected: Uint8Array, actual: Uint8Array): boolean {
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

/** `v1.<issued at, ms>.<hex tag>.<json>`: the tag covers the timestamp and the JSON. */
export function sealMembershipChange(
  change: MembershipChange,
  secret: string,
  now: number = Date.now(),
): string {
  const json = encodeMembershipChange(change);
  const tag = messageMac(secret, "membership", `${now}.${json}`).toString("hex");
  return `v1.${now}.${tag}.${json}`;
}

/**
 * The change inside a sealed message, or null when the message is not sealed with
 * this secret, is too old (or from the future), or is not a well-formed change.
 */
export function openMembershipChange(
  raw: string,
  secret: string,
  now: number = Date.now(),
): MembershipChange | null {
  const parts = /^v1\.(\d{1,16})\.([0-9a-f]{64})\.(.*)$/s.exec(raw);
  if (!parts) return null;
  const [, issuedText, tagHex, json] = parts as unknown as [string, string, string, string];
  const issued = Number(issuedText);
  if (!issuedWithinWindow(issued, now)) return null;
  const expected = messageMac(secret, "membership", `${issuedText}.${json}`);
  if (!macMatches(expected, Buffer.from(tagHex, "hex"))) return null;
  return parseMembershipChange(json);
}
