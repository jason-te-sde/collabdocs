import {
  COLLAB_EVENTS,
  can,
  type RejectReason,
  type RevokedNotice,
  type MembershipChange,
  type Role,
} from "@collabdocs/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Limits, PersistenceOptions } from "./config";
import { errorFields, type Logger } from "./logger";
import type { DocumentStore } from "./store";
import type { ClientOrigin, CollabIo, CollabSocket, RelayKind } from "./types";

/** Applied on behalf of another instance. `userId` is set for awareness, whose ids belong to a user. */
interface RemoteOrigin {
  kind: "remote";
  userId?: string | undefined;
}
const REMOTE: RemoteOrigin = { kind: "remote" };
const LOAD = { kind: "load" } as const;
const DISCONNECT = { kind: "disconnect" } as const;

type AnyOrigin = ClientOrigin | RemoteOrigin | typeof LOAD | typeof DISCONNECT | string | null;

export interface DocumentDeps {
  io: CollabIo;
  store: DocumentStore;
  logger: Logger;
  persistence: PersistenceOptions;
  limits: Limits;
  /** Sends a message to the other instances. A no-op when the server runs alone. */
  relay: (documentId: string, kind: RelayKind, data: Uint8Array, userId?: string) => void;
  /** Called once when the entry is gone, so the registry can forget it. */
  onGone: (entry: DocumentEntry) => void;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/** Consecutive failed membership re-checks after which the document's sockets are closed. */
const RECHECK_FAILURES_BEFORE_DISCONNECT = 3;

/** The most awareness ids (browser tabs, in practice) one socket may announce. */
const MAX_AWARENESS_IDS_PER_SOCKET = 8;
/** The most states one awareness message may carry. */
const MAX_AWARENESS_ENTRIES = 16;

/** One state of an awareness update: a client id, its clock and its state (null removes it). */
interface AwarenessEntry {
  id: number;
  clock: number;
  state: unknown;
}

/** The entries of an awareness update, or null if it is not well formed. */
function parseAwareness(bytes: Uint8Array): AwarenessEntry[] | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const count = decoding.readVarUint(decoder);
    if (count > MAX_AWARENESS_ENTRIES) return null;
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      entries.push({ id, clock, state: JSON.parse(decoding.readVarString(decoder)) as unknown });
    }
    return entries;
  } catch {
    return null;
  }
}

function encodeSync(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
}

type State = "loading" | "ready" | "closing" | "gone";
/** The inverse of `parseAwareness`, in the y-protocols wire format. */
function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.id);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}


/**
 * One document held in memory by one instance: its Y.Doc, its awareness state,
 * the sockets connected to it here, and the work that keeps it in step with the
 * database (appending, compacting, reading what other instances wrote).
 *
 * The invariants:
 *  - Only an update that came from a client of this instance is appended, and it
 *    is appended once. Updates that arrive from other instances or from the
 *    database are applied with a different origin and never persisted here.
 *  - An update reaches the other instances only after it is in the log.
 *  - If the log cannot be written the entry is dropped and its sockets are
 *    disconnected. The database is the truth; clients resync from it on reconnect
 *    and send whatever it lacks.
 */
export class DocumentEntry {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly sockets = new Set<CollabSocket>();
  readonly ready: Promise<void>;
  /** Resolves when a close has finished. */
  closed: Promise<void> | null = null;
  state: State = "loading";

  private readonly room: string;
  private pending: Uint8Array[] = [];
  /** Bytes of updates accepted but not yet committed: the queue plus the batch being written. */
  private pendingBytes = 0;
  /** Bytes the document occupies in the database: the last count plus what this entry appended since. */
  private storedBytes = 0;
  private drainPromise: Promise<void> | null = null;
  private uncompacted = 0;
  private compactTimer: NodeJS.Timeout | null = null;
  private compacting: Promise<void> | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private cursor = -1;
  private recheckFailures = 0;
  /** Which user each awareness client id belongs to; a socket may only touch its own user's ids. */
  private readonly awarenessOwners = new Map<number, string>();

  constructor(
    readonly id: string,
    private readonly deps: DocumentDeps,
  ) {
    this.room = `doc:${id}`;
    // The server is not a participant: it has no cursor of its own.
    this.awareness.setLocalState(null);
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.ready = this.load();
    // The registry reports a failed load to whoever waits for `ready`.
    this.ready.catch(() => {});
  }

  // ---- loading ---------------------------------------------------------

  private async load(): Promise<void> {
    try {
      const stored = await this.deps.store.read(this.id, -1);
      if (stored.snapshot) Y.applyUpdate(this.doc, stored.snapshot, LOAD);
      for (const row of stored.updates) this.applyStored(row.data, row.seq);
      this.cursor = stored.lastSeq;
      this.uncompacted = stored.updates.length;
      this.storedBytes = await this.deps.store.storedBytes(this.id);
      this.state = "ready";
      this.startTimers();
      if (this.uncompacted >= this.deps.persistence.compactEveryUpdates) this.compactSoon();
      else if (this.uncompacted > 0) this.armCompactTimer();
    } catch (error) {
      this.deps.logger.error("document load failed", {
        documentId: this.id,
        ...errorFields(error),
      });
      this.destroy();
      throw error;
    }
  }

  private applyStored(data: Uint8Array, seq: number): void {
    try {
      Y.applyUpdate(this.doc, data, LOAD);
    } catch (error) {
      this.deps.logger.error("stored update could not be applied", {
        documentId: this.id,
        seq,
        ...errorFields(error),
      });
    }
  }

  // ---- sockets -----------------------------------------------------------

  attach(socket: CollabSocket): void {
    this.cancelUnload();
    this.sockets.add(socket);
    void socket.join(this.room);
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) {
      socket.emit(
        COLLAB_EVENTS.awareness,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, present),
      );
    }
    // Only a writer has anything to offer, so only a writer is asked for its state.
    if (can(socket.data.role, "write")) {
      socket.emit(
        COLLAB_EVENTS.sync,
        encodeSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.doc)),
      );
    }
  }

  detach(socket: CollabSocket): void {
    if (!this.sockets.delete(socket)) return;
    const announced = socket.data.origin.awarenessIds;
    if (this.state === "ready" && announced.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...announced], DISCONNECT);
    }
    if (this.sockets.size === 0 && this.state === "ready") this.armUnload();
  }

  /** Disconnects this instance's sockets of one user (or all of them) after a membership change. */
  revoke(change: MembershipChange): void {
    for (const socket of [...this.sockets]) {
      if (change.userId === null || socket.data.userId === change.userId) {
        this.revokeSocket(socket, change.change);
      }
    }
  }

  private revokeSocket(socket: CollabSocket, reason: RevokedNotice["reason"]): void {
    this.deps.logger.info("socket revoked", {
      documentId: this.id,
      userId: socket.data.userId,
      reason,
    });
    const notice: RevokedNotice = { reason };
    socket.emit(COLLAB_EVENTS.revoked, notice);
    socket.disconnect(true);
  }

  /**
   * Checks the socket's membership against the database, unless it was checked
   * within `roleCacheMs`; `force` always checks. A removed or changed membership
   * closes the socket and returns false, and so does a database that cannot
   * answer: a socket whose right cannot be confirmed must not write.
   */
  async confirmRole(socket: CollabSocket, force = false): Promise<boolean> {
    if (!force && Date.now() - socket.data.roleCheckedAt < this.deps.persistence.roleCacheMs) {
      return true;
    }
    let current: Role | null;
    try {
      current = await this.deps.store.role(this.id, socket.data.userId);
    } catch (error) {
      this.deps.logger.error("membership check failed; disconnecting", {
        documentId: this.id,
        userId: socket.data.userId,
        ...errorFields(error),
      });
      socket.disconnect(true);
      return false;
    }
    socket.data.roleCheckedAt = Date.now();
    if (current === null) {
      this.revokeSocket(socket, "removed");
      return false;
    }
    if (current !== socket.data.memberRole) {
      this.revokeSocket(socket, "role-changed");
      return false;
    }
    return true;
  }

  // ---- messages from clients -------------------------------------------

  private reject(socket: CollabSocket, event: string, reason: RejectReason, detail?: string): void {
    this.deps.logger.warn("message rejected", {
      documentId: this.id,
      userId: socket.data.userId,
      role: socket.data.role,
      event,
      reason,
      ...(detail ? { detail } : {}),
    });
    socket.emit(COLLAB_EVENTS.rejected, { event, reason });
  }

  /** A y-protocols sync message. Step 1 needs `read`; step 2 and update need `write`. */
  async onSync(socket: CollabSocket, payload: unknown): Promise<void> {
    const event = COLLAB_EVENTS.sync;
    if (this.state !== "ready") return;
    const bytes = toBytes(payload);
    if (!bytes) return this.reject(socket, event, "malformed", "payload is not binary");
    if (bytes.byteLength > this.deps.limits.maxUpdateBytes) {
      return this.reject(socket, event, "too_large", `${bytes.byteLength} bytes`);
    }
    let decoder: decoding.Decoder;
    let type: number;
    try {
      decoder = decoding.createDecoder(bytes);
      type = decoding.readVarUint(decoder);
    } catch {
      return this.reject(socket, event, "malformed", "unreadable message type");
    }
    switch (type) {
      case syncProtocol.messageYjsSyncStep1: {
        if (!can(socket.data.role, "read")) return this.reject(socket, event, "forbidden");
        try {
          const stateVector = decoding.readVarUint8Array(decoder);
          socket.emit(
            COLLAB_EVENTS.sync,
            encodeSync((encoder) => syncProtocol.writeSyncStep2(encoder, this.doc, stateVector)),
          );
        } catch {
          this.reject(socket, event, "malformed", "bad state vector");
        }
        return;
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        // A step 2 carries document content, exactly like an update: the same right is needed.
        if (!can(socket.data.role, "write")) return this.reject(socket, event, "forbidden");
        // The role in the token and at connect time may be out of date: a removal or a
        // demotion takes effect on the next write, not at the next re-check.
        if (!(await this.confirmRole(socket)) || this.state !== "ready") return;
        // A revocation may have arrived while the role was being read.
        if (!socket.connected) return;
        try {
          const update = decoding.readVarUint8Array(decoder);
          if (!this.admit(socket, event, update)) return;
          Y.applyUpdate(this.doc, update, socket.data.origin);
          if (!this.withinPendingStructCap(socket, event)) return;
        } catch (error) {
          this.reject(socket, event, "malformed", errorFields(error).detail as string);
        }
        return;
      }
      default:
        this.reject(socket, event, "malformed", `unknown sync message type ${type}`);
    }
  }

  /**
   * Bytes of Yjs structure the document holds back because the updates they depend on
   * have not arrived (`pendingStructs` and `pendingDs`). Such an update fires no
   * `update` event and is never written, but it stays in memory, so it counts.
   */
  private unresolvedBytes(): number {
    const store = this.doc.store;
    return (store.pendingStructs?.update.byteLength ?? 0) + (store.pendingDs?.byteLength ?? 0);
  }

  /**
   * After an update was applied: the unresolved structure of the document must stay
   * under its cap. Past it the held structure is dropped (a client that is honest
   * sends it again after it reconnects and syncs), the socket is told why and closed.
   */
  private withinPendingStructCap(socket: CollabSocket, event: string): boolean {
    const held = this.unresolvedBytes();
    if (held <= this.deps.limits.maxPendingStructBytes) return true;
    this.doc.store.pendingStructs = null;
    this.doc.store.pendingDs = null;
    this.deps.logger.warn("unresolved updates over the cap; disconnecting", {
      documentId: this.id,
      userId: socket.data.userId,
      heldBytes: held,
    });
    socket.emit(COLLAB_EVENTS.rejected, { event, reason: "overloaded" });
    socket.disconnect(true);
    return false;
  }

  /** True when an update contains no new content, only deletions of what exists. */
  private onlyDeletes(update: Uint8Array): boolean {
    try {
      return Y.decodeUpdate(update).structs.length === 0;
    } catch {
      return false;
    }
  }

  /**
   * Decides whether an update may be applied. Two bounds protect the database and
   * this process: the document's total size, and the updates waiting to be written.
   * Both count what is held back for want of a dependency, as soon as it is received.
   * The check runs before the update touches the Y.Doc, so a refusal leaves the state
   * as it was. An update that only deletes passes the size cap: refusing it would
   * leave a full document no way to become smaller.
   */
  private admit(socket: CollabSocket, event: string, update: Uint8Array): boolean {
    const { maxDocumentBytes, maxPendingBytes } = this.deps.limits;
    const size = update.byteLength;
    const held = this.unresolvedBytes();
    if (this.storedBytes + this.pendingBytes + held + size > maxDocumentBytes) {
      // A compaction may shrink what is stored, so try one before the next write.
      if (this.uncompacted > 0) this.compactSoon();
      if (!this.onlyDeletes(update)) {
        this.reject(
          socket,
          event,
          "document_full",
          `${this.storedBytes + this.pendingBytes + held} bytes`,
        );
        return false;
      }
    }
    if (this.pendingBytes + held + size > maxPendingBytes) {
      // The database is not keeping up with this socket. Reading from it cannot be
      // paused with Socket.IO, so close it: its client keeps the edit and sends it
      // again after the reconnect.
      this.deps.logger.warn("update queue is full; disconnecting", {
        documentId: this.id,
        userId: socket.data.userId,
        pendingBytes: this.pendingBytes,
      });
      socket.emit(COLLAB_EVENTS.rejected, { event, reason: "overloaded" });
      socket.disconnect(true);
      return false;
    }
    return true;
  }

  /**
   * An awareness update (cursor, name, colour). Needs `read`: a viewer may show a
   * cursor. Two things are bound to the sender, so nobody can fake or erase another
   * person's presence. An awareness id belongs to the user who first announced it: a
   * socket may set or remove the states of its own user's ids and no others. And every
   * state a socket sets must name that socket's own user (`user.id`); the name that is
   * shown is the one in the token, which the web app wrote from the session, and it
   * replaces whatever name the client put in the state.
   */
  async onAwareness(socket: CollabSocket, payload: unknown): Promise<void> {
    const event = COLLAB_EVENTS.awareness;
    if (this.state !== "ready") return;
    if (!can(socket.data.role, "read")) return this.reject(socket, event, "forbidden");
    const bytes = toBytes(payload);
    if (!bytes) return this.reject(socket, event, "malformed", "payload is not binary");
    if (bytes.byteLength > this.deps.limits.maxAwarenessBytes) {
      return this.reject(socket, event, "too_large", `${bytes.byteLength} bytes`);
    }
    const entries = parseAwareness(bytes);
    if (!entries) return this.reject(socket, event, "malformed", "unreadable awareness update");
    const { userId, origin } = socket.data;
    let fresh = 0;
    for (const { id } of entries) {
      const owner = this.awarenessOwners.get(id);
      if (owner !== undefined && owner !== userId) {
        return this.reject(socket, event, "forbidden", "client id belongs to another user");
      }
      if (!origin.awarenessIds.has(id)) fresh += 1;
    }
    if (origin.awarenessIds.size + fresh > MAX_AWARENESS_IDS_PER_SOCKET) {
      return this.reject(socket, event, "forbidden", "too many client ids");
    }
    // The user's earlier socket may still hold these ids (a reconnect that overtook
    // the old socket's close): they move to this socket, so the old one's close
    // does not erase them.
    for (const other of this.sockets) {
      if (other === socket) continue;
      for (const { id } of entries) other.data.origin.awarenessIds.delete(id);
    }
    try {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        encodeAwarenessEntries(entries),
        origin,
      );
    } catch (error) {
      this.reject(socket, event, "malformed", errorFields(error).detail as string);
    }
  }

  // ---- messages from other instances and from the database ---------------

  /** A message another instance relayed. Applied with the REMOTE origin: never persisted here. */
  applyRemote(kind: RelayKind, data: Uint8Array, userId?: string): void {
    void this.ready.then(
      () => {
        if (this.state !== "ready") return;
        try {
          if (kind === "update") Y.applyUpdate(this.doc, data, REMOTE);
          else
            awarenessProtocol.applyAwarenessUpdate(this.awareness, data, {
              kind: "remote",
              userId,
            });
        } catch (error) {
          this.deps.logger.warn("relayed message could not be applied", {
            documentId: this.id,
            kind,
            ...errorFields(error),
          });
        }
      },
      () => {},
    );
  }

  /**
   * Reads the log past this entry's cursor and applies what it finds. Pub/sub is
   * at-most-once; this makes it a latency optimisation rather than the thing
   * convergence depends on. Applying an update twice is a no-op in Yjs.
    for (const entry of entries) {
      if (entry.state === null) continue; // a removal needs no identity, only ownership
      const problem = this.vouchFor(socket, entry);
      if (problem) return this.reject(socket, event, problem.reason, problem.detail);
    }
   */
  private async reconcile(): Promise<void> {
    if (this.state !== "ready") return;
    try {
      const stored = await this.deps.store.read(this.id, this.cursor);
      if (this.state !== "ready") return;
      if (stored.snapshot) Y.applyUpdate(this.doc, stored.snapshot, REMOTE);
      for (const row of stored.updates) {
        try {
          Y.applyUpdate(this.doc, row.data, REMOTE);
        } catch (error) {
          this.deps.logger.error("stored update could not be applied", {
            documentId: this.id,
            seq: row.seq,
  /**
   * Checks that a presence state names the socket's own user and puts the name from
   * the token into it. Returns why the state is refused, or null when it passes (the
   * entry is then rewritten in place).
   */
  private vouchFor(
    socket: CollabSocket,
    entry: AwarenessEntry,
  ): { reason: RejectReason; detail: string } | null {
    const { state } = entry;
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { reason: "malformed", detail: "presence state is not an object" };
    }
    const user = (state as { user?: unknown }).user;
    if (typeof user !== "object" || user === null || Array.isArray(user)) {
      return { reason: "forbidden", detail: "presence carries no user" };
    }
    if ((user as { id?: unknown }).id !== socket.data.userId) {
      return { reason: "forbidden", detail: "presence names another user" };
    }
    entry.state = { ...state, user: { ...user, name: socket.data.name } };
    return null;
  }

            ...errorFields(error),
          });
        }
      }
      this.cursor = stored.lastSeq;
      // Other instances append too; this is how their bytes count against the cap.
      this.storedBytes = await this.deps.store.storedBytes(this.id);
    } catch (error) {
      this.deps.logger.warn("reconcile failed", { documentId: this.id, ...errorFields(error) });
    }
  }

  /** Disconnects sockets whose membership is gone or whose role changed. A safety net for lost pub/sub messages. */
  private async recheckMembers(): Promise<void> {
    if (this.state !== "ready" || this.sockets.size === 0) return;
    try {
      const roles = await this.deps.store.roles(this.id);
      this.recheckFailures = 0;
      for (const socket of [...this.sockets]) {
        const current = roles.get(socket.data.userId);
        if (current === undefined) {
          this.revoke({ documentId: this.id, userId: socket.data.userId, change: "removed" });
        } else if (current !== socket.data.memberRole) {
          this.revoke({ documentId: this.id, userId: socket.data.userId, change: "role-changed" });
        }
      }
    } catch (error) {
      this.recheckFailures += 1;
      this.deps.logger.warn("membership re-check failed", {
        documentId: this.id,
        failures: this.recheckFailures,
        ...errorFields(error),
      });
      // The re-check is the safety net for a lost revocation. If it cannot run, nobody can
      // vouch for the sockets, so close them; they reconnect through the handshake, which
      // needs the database too.
      if (this.recheckFailures >= RECHECK_FAILURES_BEFORE_DISCONNECT) {
        this.deps.logger.error("memberships cannot be verified; disconnecting the sockets", {
          documentId: this.id,
        });
        for (const socket of [...this.sockets]) socket.disconnect(true);
      }
    }
  }

  // ---- Yjs events ------------------------------------------------------------

  private readonly onDocUpdate = (update: Uint8Array, origin: AnyOrigin): void => {
    if (origin === LOAD || origin === null || typeof origin === "string") return;
    const message = encodeSync((encoder) => syncProtocol.writeUpdate(encoder, update));
    if (origin.kind === "client") {
      this.emitLocal(COLLAB_EVENTS.sync, message, origin.socketId);
      this.enqueue(update);
    } else if (origin.kind === "remote") {
      this.emitLocal(COLLAB_EVENTS.sync, message);
    }
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: AnyOrigin,
  ): void => {
    const changed = [...change.added, ...change.updated, ...change.removed];
    if (changed.length === 0) return;
    const fromClient = typeof origin === "object" && origin !== null && origin.kind === "client";
    const remoteUser =
      typeof origin === "object" && origin !== null && origin.kind === "remote"
        ? origin.userId
        : undefined;
    // Who the change is about, for the other instances; read before ownership is updated.
    const user = fromClient ? origin.userId : (remoteUser ?? this.awarenessOwners.get(changed[0]!));
    if (fromClient) {
      for (const id of [...change.added, ...change.updated]) origin.awarenessIds.add(id);
      for (const id of change.removed) origin.awarenessIds.delete(id);
    }
    const owner = fromClient ? origin.userId : remoteUser;
    if (owner)
      for (const id of [...change.added, ...change.updated]) this.awarenessOwners.set(id, owner);
    for (const id of change.removed) this.awarenessOwners.delete(id);
    const message = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
    this.emitLocal(COLLAB_EVENTS.awareness, message, fromClient ? origin.socketId : undefined);
    // Presence is relayed when it began here. A timeout of a remote client's state is
    // decided independently on each instance and must not echo back.
    if (fromClient || origin === DISCONNECT) this.deps.relay(this.id, "awareness", message, user);
  };

  private emitLocal(event: "sync" | "awareness", data: Uint8Array, exceptSocketId?: string): void {
    let target = this.deps.io.local.to(this.room);
    if (exceptSocketId) target = target.except(exceptSocketId);
    target.emit(event, data);
  }

  // ---- persistence --------------------------------------------------------------

  private enqueue(update: Uint8Array): void {
    this.pending.push(update);
    this.pendingBytes += update.byteLength;
    this.kick();
  }

  /** Appends queued updates in batches, one transaction per batch, then relays them. */
  private kick(): void {
    if (this.drainPromise || this.state === "gone") return;
    this.drainPromise = (async () => {
      try {
        while (this.pending.length > 0 && this.state !== "gone") {
          const batch = this.pending;
          const batchBytes = batch.reduce((sum, update) => sum + update.byteLength, 0);
          this.pending = [];
          try {
            await this.deps.store.append(this.id, batch);
          } catch (error) {
            this.fail(error);
            return;
          }
          this.pendingBytes -= batchBytes;
          this.storedBytes += batchBytes;
          this.deps.relay(
            this.id,
            "update",
            batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch),
          );
          this.uncompacted += batch.length;
          if (this.uncompacted >= this.deps.persistence.compactEveryUpdates) this.compactSoon();
          else this.armCompactTimer();
        }
      } finally {
        this.drainPromise = null;
      }
    })();
  }

  private async flush(): Promise<void> {
    while (this.drainPromise) await this.drainPromise;
  }

  private armCompactTimer(): void {
    if (this.compactTimer || this.state === "gone" || this.state === "closing") return;
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      void this.compact();
    }, this.deps.persistence.compactAfterMs);
    this.compactTimer.unref();
  }

  private compactSoon(): void {
    if (this.state === "gone" || this.state === "closing") return;
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = null;
    void this.compact();
  }

  /**
   * Compacts in the database. One at a time per entry; the store serialises across
   * instances. The count of uncompacted updates drops only when the compaction
   * has succeeded: a failed one leaves it as it was, is retried after
   * `compactAfterMs`, and is tried once more when the entry closes.
   */
  private compact(): Promise<void> {
    if (this.compacting) return this.compacting;
    const covered = this.uncompacted;
    this.compacting = (async () => {
      try {
        const result = await this.deps.store.compact(this.id);
        this.uncompacted = Math.max(0, this.uncompacted - covered);
        if (result) {
          this.deps.logger.info("document compacted", { documentId: this.id, ...result });
        }
        // A smaller snapshot gives a document that hit its size cap room again.
        this.storedBytes = await this.deps.store.storedBytes(this.id).catch(() => this.storedBytes);
      } catch (error) {
        this.deps.logger.error("compaction failed", { documentId: this.id, ...errorFields(error) });
        this.armCompactTimer();
      } finally {
        this.compacting = null;
      }
    })();
    return this.compacting;
  }

  private fail(error: unknown): void {
    this.deps.logger.error("update log write failed; dropping the document from memory", {
      documentId: this.id,
      ...errorFields(error),
    });
    const sockets = [...this.sockets];
    this.destroy();
    for (const socket of sockets) socket.disconnect(true);
  }

  // ---- lifecycle ----------------------------------------------------------------------

  private startTimers(): void {
    const { reconcileIntervalMs, membershipRecheckMs } = this.deps.persistence;
    this.reconcileTimer = setInterval(() => void this.reconcile(), reconcileIntervalMs);
    this.reconcileTimer.unref();
    this.recheckTimer = setInterval(() => void this.recheckMembers(), membershipRecheckMs);
    this.recheckTimer.unref();
  }

  private armUnload(): void {
    this.cancelUnload();
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      if (this.sockets.size === 0) void this.close();
    }, this.deps.persistence.unloadGraceMs);
    this.unloadTimer.unref();
  }

  cancelUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  /** Writes what is queued, compacts if anything is uncompacted, and frees the memory. */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closed = (async () => {
      if (this.state === "gone") return;
      this.state = "closing";
      this.clearTimers();
      await this.flush();
      if (this.compacting) await this.compacting;
      if (this.uncompacted > 0 && this.state === "closing") await this.compact();
      this.destroy();
    })();
    return this.closed;
  }

  private clearTimers(): void {
    for (const timer of [
      this.compactTimer,
      this.unloadTimer,
      this.reconcileTimer,
      this.recheckTimer,
    ]) {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    this.compactTimer = this.unloadTimer = this.reconcileTimer = this.recheckTimer = null;
  }

  private destroy(): void {
    if (this.state === "gone") return;
    this.state = "gone";
    this.clearTimers();
    this.pending = [];
    this.pendingBytes = 0;
    this.awareness.destroy();
    this.doc.destroy();
    this.deps.onGone(this);
  }
}

/** The documents this instance holds, keyed by id. */
export class DocumentRegistry {
  private readonly entries = new Map<string, DocumentEntry>();

  constructor(private readonly deps: Omit<DocumentDeps, "onGone">) {}

  get(id: string): DocumentEntry | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** The loaded entry for a document, loading it first if needed. Throws if it cannot be loaded. */
  async acquire(id: string): Promise<DocumentEntry> {
    for (;;) {
      let entry = this.entries.get(id);
      if (entry?.state === "closing" && entry.closed) {
        await entry.closed;
        continue;
      }
      if (!entry) {
        entry = new DocumentEntry(id, {
          ...this.deps,
          onGone: (gone) => {
            if (this.entries.get(id) === gone) this.entries.delete(id);
          },
        });
        this.entries.set(id, entry);
      }
      entry.cancelUnload();
      await entry.ready;
      if (entry.state === "ready") return entry;
    }
  }

  revoke(change: MembershipChange): void {
    this.entries.get(change.documentId)?.revoke(change);
  }

  applyRemote(id: string, kind: RelayKind, data: Uint8Array, userId?: string): void {
    this.entries.get(id)?.applyRemote(kind, data, userId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.close()));
  }
}
