import type { EventEmitter } from "node:events";
import type { CollabSocket } from "./types";

/**
 * What Engine.IO keeps for one client that has not been written out yet. Neither field is
 * part of Engine.IO's typed interface; both are read defensively, so a transport that has
 * no such field counts as nothing queued beyond the write buffer.
 */
interface EngineInternals {
  /** Packets waiting for the transport to be free. Only its length is ever read here. */
  writeBuffer?: unknown[];
  transport?: {
    /** For the WebSocket transport, the `ws` socket. */
    socket?: {
      bufferedAmount?: number;
      terminate?: () => void;
      /**
       * The TCP socket under the WebSocket. The bytes in its handle's write queue are the
       * ones the kernel has not accepted yet, and they shrink as the client reads.
       */
      _socket?: { _handle?: { writeQueueSize?: number } };
    };
  };
  /** What Engine.IO itself runs when a transport closes. */
  onClose?: (reason: string) => void;
}

/** An Engine.IO packet as the `packetCreate` and `packet` events carry it. */
export interface EnginePacket {
  type?: string;
  data?: unknown;
}

function packetBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

const internals = (conn: unknown): EngineInternals => conn as EngineInternals;

/** Bytes in a connection's write buffer, kept as a running count. */
const queuedInBuffer = new WeakMap<object, { bytes: number }>();

/**
 * Starts counting what is queued for a connection, and passes every packet it receives to
 * `onPacket`.
 *
 * The queue is measured with a running count, never by walking Engine.IO's write buffer,
 * so asking how much is queued costs the same however long a client has not read: a
 * packet adds its size when Engine.IO creates it (`packetCreate`) and the whole count goes
 * when the buffer is handed to the transport (`flush`, which moves every packet at once).
 * The packets handed over are then counted by the WebSocket's `bufferedAmount`. The
 * handshake's own `open` packet is created before this runs and is not counted, which
 * makes the count short by one small packet at most.
 */
export function guardConnection(conn: unknown, onPacket: (packet: EnginePacket) => void): void {
  const emitter = conn as EventEmitter;
  const state = { bytes: 0 };
  queuedInBuffer.set(conn as object, state);
  emitter.on("packetCreate", (packet: EnginePacket) => {
    state.bytes += packetBytes(packet.data);
  });
  emitter.on("flush", () => {
    state.bytes = 0;
  });
  emitter.on("packet", onPacket);
}

/**
 * Bytes the server holds for this connection and the client has not taken: the packets in
 * Engine.IO's write buffer (a running count, see `guardConnection`) plus what the WebSocket
 * has accepted but not yet handed to the operating system (`bufferedAmount`: its own queue
 * and the net socket's writable buffer). Bytes already in the kernel's send buffer are not
 * counted; they are bounded by the kernel. Constant time.
 */
export function queuedBytes(conn: unknown): number {
  return (
    (queuedInBuffer.get(conn as object)?.bytes ?? 0) +
    (internals(conn).transport?.socket?.bufferedAmount ?? 0)
  );
}

/** Packets in the connection's write buffer, not yet handed to the transport. Constant time. */
export function queuedPackets(conn: unknown): number {
  return internals(conn).writeBuffer?.length ?? 0;
}

/** What the last sweep saw of a connection. */
interface SweepSample {
  bytes: number;
  packets: number;
  /** Bytes the kernel has not accepted yet, if the transport can say. */
  pending: number | undefined;
  overBytes: boolean;
  overPackets: boolean;
}
const lastSweep = new WeakMap<object, SweepSample>();

/**
 * For the periodic sweep: whether a connection is over a cap and not draining. It is when,
 * at this sweep and at the one before, the same measure (bytes or packets) was over its
 * cap, and nothing was taken since: the bytes the kernel has not accepted (the write queue
 * of the TCP socket's handle) did not shrink and the queue has not shrunk. `bufferedAmount`
 * alone cannot show a download in progress, because a WebSocket counts a message it is
 * still writing in full until its last byte is out; the handle's write queue shrinks as the
 * client reads. A client that is taking a
 * large reply is left alone however long that takes; one that has stopped reading is
 * closed at its second sweep over the cap. Call it once per sweep per connection: it
 * remembers what it saw.
 */
export function stalledOverCap(conn: unknown, maxBytes: number, maxPackets: number): boolean {
  const key = conn as object;
  const bytes = queuedBytes(conn);
  const packets = queuedPackets(conn);
  const pending = internals(conn).transport?.socket?._socket?._handle?.writeQueueSize;
  const before = lastSweep.get(key);
  const overBytes = bytes > maxBytes;
  const overPackets = packets > maxPackets;
  lastSweep.set(key, { bytes, packets, pending, overBytes, overPackets });
  if (!before) return false;
  if (pending !== undefined && before.pending !== undefined && pending < before.pending) {
    return false;
  }
  return (
    (overBytes && before.overBytes && bytes >= before.bytes) ||
    (overPackets && before.overPackets && packets >= before.packets)
  );
}

/** `queuedBytes` for the connection of a Socket.IO socket. */
export function bufferedBytes(socket: Pick<CollabSocket, "conn">): number {
  return queuedBytes(socket.conn);
}

/** `queuedPackets` for the connection of a Socket.IO socket. */
export function bufferedPackets(socket: Pick<CollabSocket, "conn">): number {
  return queuedPackets(socket.conn);
}

/**
 * Closes a connection without waiting for the peer, and frees what is queued for it. A
 * close is a handshake: the close frame is queued behind everything already queued, and
 * the peer must answer it, so a client that does not read keeps the connection, and the
 * memory queued for it, for as long as `ws` waits (30 seconds) and Engine.IO's ping
 * timeout (45 seconds by default). The WebSocket is terminated, and Engine.IO is told the
 * transport is gone, at once: it ignores what arrives after that and drops its buffer.
 */
export function dropConnection(conn: unknown): void {
  const engine = internals(conn);
  engine.transport?.socket?.terminate?.();
  engine.onClose?.("forced close");
}

/**
 * Every open Engine.IO connection of a server. `clients` is protected in Engine.IO's
 * typings but is its documented registry of connections.
 */
export function engineConnections(engine: unknown): unknown[] {
  return Object.values((engine as { clients: Record<string, unknown> }).clients);
}

/** Disconnects a socket and frees what is queued for it at once. */
export function dropSocket(socket: CollabSocket): void {
  socket.disconnect(true);
  dropConnection(socket.conn);
}
