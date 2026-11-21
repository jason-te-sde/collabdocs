import type { EventEmitter } from "node:events";
import type { CollabSocket } from "./types";

/**
 * What Engine.IO keeps for one client that has not been written out yet. Neither field is
 * part of Engine.IO's typed interface; both are read defensively, so a transport that has
 * no such field (long polling) counts as nothing queued beyond the write buffer.
 */
interface EngineInternals {
  /** Packets waiting for the transport to be free. Only its length is ever read here. */
  writeBuffer?: unknown[];
  transport?: {
    /** For the WebSocket transport, the `ws` socket. */
    socket?: { bufferedAmount?: number; terminate?: () => void };
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
