import type { RejectedNotice, RevokedNotice, Role } from "@collabdocs/shared";
import type { Server, Socket } from "socket.io";

export interface ClientToServerEvents {
  sync: (data: unknown) => void;
  awareness: (data: unknown) => void;
}

export interface ServerToClientEvents {
  sync: (data: Uint8Array) => void;
  awareness: (data: Uint8Array) => void;
  rejected: (notice: RejectedNotice) => void;
  revoked: (notice: RevokedNotice) => void;
}

/** What one instance tells the others about a document it holds. */
export type RelayKind = "update" | "awareness";

/** The adapter's server-to-server events are not used; Yjs traffic has its own channel. */
export type InterServerEvents = Record<string, never>;

/** The origin attached to Yjs transactions that a client's message caused. */
export interface ClientOrigin {
  kind: "client";
  socketId: string;
  /** Whose socket it is: awareness ids belong to a user, not to a connection. */
  userId: string;
  /** Awareness client ids this socket has announced; they are removed when it leaves. */
  awarenessIds: Set<number>;
}

export interface SocketData {
  documentId: string;
  userId: string;
  /** The role this socket acts with: the weaker of the token's role and the membership at connect time. */
  role: Role;
  /** The membership role found in the database at connect time. */
  memberRole: Role;
  /** When the membership was last read from the database for this socket (ms since the epoch). */
  roleCheckedAt: number;
  origin: ClientOrigin;
}

export type CollabIo = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type CollabSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
