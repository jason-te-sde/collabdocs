import {
  COLLAB_EVENTS,
  type RejectedNotice,
  type RejectReason,
  type RevokedNotice,
} from "@collabdocs/shared/collab-protocol";
import { can, type Role } from "@collabdocs/shared/permissions";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { io } from "socket.io-client";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * A client for the collab server's Socket.IO contract (docs/design/0003): one
 * connection per document, y-protocols sync and awareness messages in the
 * `sync` and `awareness` events, a short-lived token in the handshake.
 *
 * Reconnecting is done here and not by Socket.IO, because every attempt needs a
 * fresh token and because a handshake the server refuses is not retried by
 * Socket.IO at all. The Y.Doc is never touched on a disconnect: edits made
 * offline stay in it, and the sync handshake of the next connection sends them.
 */

export type ConnectionState =
  /** The first attempt is in progress. */
  | "connecting"
  | "connected"
  /** The connection was lost, or an attempt failed, and another is scheduled or running. */
  | "reconnecting"
  /** The browser reports no network. No attempt is made until it is back. */
  | "offline"
  /** The server refuses this user: not a member (any more), or not signed in. */
  | "denied";

export interface CollabSnapshot {
  state: ConnectionState;
  /** The role the current token carries; null before the first token. */
  role: Role | null;
  /** True when the role cannot write: the editor must not accept input. */
  readOnly: boolean;
  /** The server's state has been received on this connection. */
  synced: boolean;
  /**
   * Local changes may not have reached the server: they were made (or loaded
   * from this device) while no sync handshake had completed.
   */
  unsynced: boolean;
  deniedReason: "signed-out" | "no-access" | null;
  /**
   * Why the server refused the user's last write (a `rejected` notice), or null. While it is
   * set the editor is not saving: it says so and what to do. Cleared by `dismissRejection`
   * and when a new connection finishes its sync handshake; if the cause is still there, the
   * next refused write sets it again. A code this client does not know is "unknown".
   */
  rejection: RejectReason | "unknown" | null;
}

const KNOWN_REASONS: readonly string[] = [
  "forbidden",
  "too_large",
  "malformed",
  "document_full",
  "overloaded",
];

/** The part of a Socket.IO client socket that the provider uses. */
export interface SocketLike {
  readonly connected: boolean;
  auth: unknown;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, handler: (...args: never[]) => void): unknown;
  emit(event: string, data?: unknown): unknown;
}

export interface NetworkStatus {
  isOnline(): boolean;
  /** Calls the listener when the browser goes on or offline; returns the unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void;
}

/** The token endpoint refused: 401 means signed out, 403 and 404 mean no access. */
export class CollabAccessError extends Error {
  constructor(readonly status: number) {
    super(`the collaboration token was refused (${status})`);
    this.name = "CollabAccessError";
  }
}

export interface CollabToken {
  token: string;
  role: Role;
}

export interface CollabProviderOptions {
  documentId: string;
  doc: Y.Doc;
  /** Origin of the collab server. */
  url: string;
  /** Fetches a fresh token; throws CollabAccessError when the user has no access. */
  fetchToken: () => Promise<CollabToken>;
  createSocket?: (url: string) => SocketLike;
  network?: NetworkStatus;
  random?: () => number;
  /** Delay before the first retry, in ms; doubles per failure up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const browserNetwork: NetworkStatus = {
  isOnline: () => typeof navigator === "undefined" || navigator.onLine,
  subscribe(listener) {
    const online = () => listener(true);
    const offline = () => listener(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  },
};

function defaultSocket(url: string): SocketLike {
  return io(url, {
    autoConnect: false,
    reconnection: false,
    // Socket.IO's default is 20 s; a handshake that takes longer is as good as lost.
    timeout: 10_000,
    // One transport: long polling would need sticky sessions behind a load balancer.
    transports: ["websocket"],
    forceNew: true,
  });
}

/**
 * The name of the User Timing mark made when a connection has the server's state. The
 * Lighthouse job reads it from the report of the editor page (the `user-timings` audit)
 * and fails if it is missing: a page scored while the socket was not connected would
 * otherwise pass on its category scores alone. The mark costs nothing and is harmless
 * elsewhere.
 */
export const SYNCED_MARK = "collabdocs:synced";

function markSynced(): void {
  try {
    if (typeof performance !== "undefined") performance.mark(SYNCED_MARK);
  } catch {
    // A browser without User Timing: nothing to record.
  }
}

type Listener = () => void;

export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private readonly options: CollabProviderOptions;
  private readonly network: NetworkStatus;
  private readonly random: () => number;
  private readonly socket: SocketLike;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribeNetwork: () => void;

  private snapshot: CollabSnapshot = {
    state: "connecting",
    role: null,
    readOnly: false,
    synced: false,
    unsynced: false,
    deniedReason: null,
    rejection: null,
  };
  private everConnected = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptId = 0;
  private destroyed = false;
  private started = false;
  /** This connection's handshake: the server's step 2 arrived, and our step 2 went out. */
  private gotStepTwo = false;
  private answeredStepOne = false;
  /** The server announced that it is closing this socket because access changed. */
  private revoked = false;

  constructor(options: CollabProviderOptions) {
    this.options = options;
    this.doc = options.doc;
    this.awareness = new awarenessProtocol.Awareness(options.doc);
    this.network = options.network ?? browserNetwork;
    this.random = options.random ?? Math.random;
    this.socket = (options.createSocket ?? defaultSocket)(options.url);

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.unsubscribeNetwork = this.network.subscribe((online) => this.onNetwork(online));

    this.socket.on("connect", () => this.onConnect());
    this.socket.on("disconnect", (reason: string) => this.onDisconnect(reason));
    this.socket.on("connect_error", (error: Error & { data?: { code?: string } }) =>
      this.onConnectError(error),
    );
    this.socket.on("sync", (data: ArrayBuffer | Uint8Array) => this.onSync(data));
    this.socket.on("awareness", (data: ArrayBuffer | Uint8Array) => this.onAwareness(data));
    this.socket.on("rejected", (notice: RejectedNotice) => this.onRejected(notice));
    this.socket.on("revoked", (_notice: RevokedNotice) => {
      // The server closes the socket next. Skip the backoff: the token endpoint
      // decides whether this user still has access, and with which role.
      this.revoked = true;
    });
  }

  // ---- observable state (for useSyncExternalStore) -------------------------------------

  getSnapshot = (): CollabSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<CollabSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    const changed = (Object.keys(next) as Array<keyof CollabSnapshot>).some(
      (key) => next[key] !== this.snapshot[key],
    );
    if (!changed) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  // ---- lifecycle -----------------------------------------------------------------------

  connect(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    if (!this.network.isOnline()) {
      this.update({ state: "offline" });
      return;
    }
    void this.attempt();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.attemptId += 1;
    this.clearTimer();
    this.unsubscribeNetwork();
    // Tell the others the cursor is gone while the socket is still open.
    this.awareness.setLocalState(null);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.socket.disconnect();
    this.awareness.destroy();
    this.listeners.clear();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async attempt(): Promise<void> {
    if (this.destroyed || !this.network.isOnline()) return;
    this.clearTimer();
    const id = ++this.attemptId;
    this.update({ state: this.everConnected ? "reconnecting" : "connecting" });
    let token: CollabToken;
    try {
      token = await this.options.fetchToken();
    } catch (error) {
      if (id !== this.attemptId) return;
      if (error instanceof CollabAccessError) {
        this.deny(error.status === 401 ? "signed-out" : "no-access");
      } else {
        this.scheduleRetry();
      }
      return;
    }
    if (id !== this.attemptId) return;
    this.update({ role: token.role, readOnly: !can(token.role, "write") });
    this.socket.auth = { token: token.token, documentId: this.options.documentId };
    this.socket.connect();
  }

  private scheduleRetry(immediate = false): void {
    if (this.destroyed || this.snapshot.state === "denied") return;
    if (!this.network.isOnline()) {
      this.update({ state: "offline" });
      return;
    }
    this.update({ state: "reconnecting" });
    this.clearTimer();
    const base = this.options.baseBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 8000;
    const ceiling = Math.min(max, base * 2 ** this.failures);
    // Between half and the whole ceiling, so that a restart does not bring every client back at once.
    const delay = immediate ? 0 : Math.round(ceiling * (0.5 + this.random() / 2));
    this.failures += 1;
    this.timer = setTimeout(() => void this.attempt(), delay);
  }

  private deny(reason: "signed-out" | "no-access"): void {
    this.attemptId += 1;
    this.clearTimer();
    this.markDown();
    this.update({ state: "denied", deniedReason: reason });
    this.socket.disconnect();
  }

  // ---- network -------------------------------------------------------------------------

  private onNetwork(online: boolean): void {
    if (this.destroyed || !this.started || this.snapshot.state === "denied") return;
    if (!online) {
      // Chromium keeps an open WebSocket alive when the page goes offline, so
      // close it ourselves: an offline editor must say so, and must not queue.
      this.attemptId += 1;
      this.clearTimer();
      this.socket.disconnect();
      this.markDown();
      this.update({ state: "offline" });
      return;
    }
    this.failures = 0;
    void this.attempt();
  }

  // ---- socket events -------------------------------------------------------------------

  private onConnect(): void {
    this.failures = 0;
    this.everConnected = true;
    this.gotStepTwo = false;
    this.answeredStepOne = false;
    this.update({ state: "connected", synced: false });

    this.send(COLLAB_EVENTS.sync, this.stepOne());

    // The server removed this client's awareness state when the old socket
    // dropped, and it bumped the clock by one when it did. y-protocols ignores
    // an update whose clock is not higher than the one it holds, so announce
    // ourselves with a clock two higher; otherwise an idle client stays
    // invisible after a reconnect until it moves its cursor.
    const local = this.awareness.getLocalState();
    if (local) {
      this.awareness.setLocalState(local);
      this.awareness.setLocalState(local);
      this.send(
        COLLAB_EVENTS.awareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      );
    }
  }

  private onDisconnect(_reason: string): void {
    if (this.destroyed) return;
    this.markDown();
    if (this.snapshot.state === "denied" || this.snapshot.state === "offline") return;
    // Whether the server closed the socket (a revocation), the transport failed
    // or we closed it: try again, with a new token. A revocation retries at once.
    const immediate = this.revoked;
    this.revoked = false;
    this.scheduleRetry(immediate);
  }

  private onConnectError(error: Error & { data?: { code?: string } }): void {
    if (this.destroyed) return;
    this.markDown();
    if (error.data?.code === "not_a_member") {
      this.deny("no-access");
      return;
    }
    this.scheduleRetry();
  }

  private onSync(data: ArrayBuffer | Uint8Array): void {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.peekVarUint(decoder);
    // A step 2 is a write. A viewer must not answer a step 1 with one: the
    // server would refuse it, and it has nothing the server lacks.
    if (this.snapshot.readOnly && type === syncProtocol.messageYjsSyncStep1) return;
    const reply = encoding.createEncoder();
    try {
      syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
    } catch {
      // A malformed message from the server: ignore it, keep the connection.
      return;
    }
    if (type === syncProtocol.messageYjsSyncStep2) this.gotStepTwo = true;
    if (encoding.length(reply) > 0) {
      this.send(COLLAB_EVENTS.sync, encoding.toUint8Array(reply));
      if (type === syncProtocol.messageYjsSyncStep1) this.answeredStepOne = true;
    }
    this.checkHandshake();
  }

  private checkHandshake(): void {
    if (!this.gotStepTwo) return;
    if (!this.snapshot.synced) markSynced();
    this.update({ synced: true, rejection: null });
    // For a writer the handshake is also the server's step 1, answered with our
    // step 2: that is what carries the edits made offline.
    if (this.snapshot.readOnly || this.answeredStepOne) this.update({ unsynced: false });
  }

  private onRejected(notice: RejectedNotice): void {
    // A refused cursor update costs nothing visible; only a refused write is the user's concern.
    if (notice?.event === COLLAB_EVENTS.awareness) return;
    const reason = typeof notice?.reason === "string" ? notice.reason : "";
    // What was refused is in the local document only, and is not on the server.
    this.update({
      rejection: KNOWN_REASONS.includes(reason) ? (reason as RejectReason) : "unknown",
      unsynced: !this.snapshot.readOnly || this.snapshot.unsynced,
    });
  }

  /** Hides the rejection notice; it comes back if the server refuses another write. */
  dismissRejection = (): void => {
    this.update({ rejection: null });
  };

  private onAwareness(data: ArrayBuffer | Uint8Array): void {
    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(data), this);
    } catch {
      // Ignore a malformed message.
    }
  }

  /** The connection is gone: the server's view of it no longer counts, and nor do remote cursors. */
  private markDown(): void {
    this.gotStepTwo = false;
    this.answeredStepOne = false;
    this.update({ synced: false });
    const others = [...this.awareness.getStates().keys()].filter(
      (clientId) => clientId !== this.doc.clientID,
    );
    if (others.length > 0) awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
  }

  // ---- local changes -------------------------------------------------------------------

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    const live = this.socket.connected && this.snapshot.state === "connected";
    if (!live || !this.snapshot.synced) {
      // Kept in the Y.Doc; the next handshake sends it. A viewer has nothing to send.
      if (!this.snapshot.readOnly) this.update({ unsynced: true });
    }
    if (this.snapshot.readOnly || !live) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.send(COLLAB_EVENTS.sync, encoding.toUint8Array(encoder));
  };

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    // Only our own changes go out. Remote ones came from the server, and a
    // timeout removal of a remote peer is not ours to announce.
    if (origin !== "local") return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    this.send(
      COLLAB_EVENTS.awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
  };

  private stepOne(): Uint8Array {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    return encoding.toUint8Array(encoder);
  }

  /** Emits only on an open socket: Socket.IO would otherwise buffer the message for the next connection. */
  private send(event: string, data: Uint8Array): void {
    if (this.socket.connected) this.socket.emit(event, data);
  }
}
