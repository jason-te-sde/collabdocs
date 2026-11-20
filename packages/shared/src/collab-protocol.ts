/**
 * The wire contract between a collaboration client and the collab server, and
 * between the web app and the collab server. Only constants and small parsers
 * live here, so that the web app does not pull in Yjs for them.
 */

/** Socket.IO event names. Every payload is binary except `rejected` and `revoked`. */
export const COLLAB_EVENTS = {
  /** A y-protocols sync message: sync step 1, sync step 2 or an update. */
  sync: "sync",
  /** A y-protocols awareness update (cursors and presence). */
  awareness: "awareness",
  /** Server to client: a message was refused. Payload: RejectedNotice. */
  rejected: "rejected",
  /** Server to client: access was withdrawn, the socket is about to close. Payload: RevokedNotice. */
  revoked: "revoked",
} as const;

export type RejectReason = "forbidden" | "too_large" | "malformed";

export interface RejectedNotice {
  event: string;
  reason: RejectReason;
}

export interface RevokedNotice {
  reason: "removed" | "role-changed" | "document-deleted";
}

/** Error codes in `error.data.code` of a refused handshake (`connect_error`). */
export type HandshakeErrorCode =
  "invalid_token" | "not_a_member" | "too_many_connections" | "server_error";

/** The Redis channel on which the web app announces membership changes. */
export const MEMBERSHIP_CHANNEL = "collabdocs:membership";

export type MembershipChangeKind = "removed" | "role-changed" | "document-deleted";

export interface MembershipChange {
  documentId: string;
  /** The user whose access changed; null means every user of the document. */
  userId: string | null;
  change: MembershipChangeKind;
}

export function encodeMembershipChange(change: MembershipChange): string {
  return JSON.stringify(change);
}

const KINDS: readonly string[] = ["removed", "role-changed", "document-deleted"];

/** Parses a channel message; returns null for anything that is not a well-formed change. */
export function parseMembershipChange(raw: string): MembershipChange | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { documentId, userId, change } = value as Record<string, unknown>;
  if (typeof documentId !== "string" || documentId === "") return null;
  if (userId !== null && typeof userId !== "string") return null;
  if (typeof change !== "string" || !KINDS.includes(change)) return null;
  return { documentId, userId, change: change as MembershipChangeKind };
}
