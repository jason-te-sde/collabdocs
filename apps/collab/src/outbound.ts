import type { CollabSocket } from "./types";

/**
 * What Engine.IO keeps for one client that has not been written out yet. Neither field is
 * part of Engine.IO's typed interface; both are read defensively, so a transport that has
 * no such field (long polling) counts as nothing queued beyond the write buffer.
 */
interface EngineInternals {
  /** Packets waiting for the transport to be free. */
  writeBuffer?: Array<{ data?: unknown }>;
  transport?: {
    /** For the WebSocket transport, the `ws` socket. */
    socket?: { bufferedAmount?: number; terminate?: () => void };
  };
}

function packetBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

const internals = (conn: unknown): EngineInternals => conn as EngineInternals;

/**
 * Bytes the server holds for this socket and the client has not taken: the packets in
 * Engine.IO's write buffer plus what the WebSocket has accepted but not yet handed to the
 * operating system (`bufferedAmount`: its own queue and the net socket's writable buffer).
 * Bytes already in the kernel's send buffer are not counted; they are bounded by the
 * kernel.
 */
export function bufferedBytes(socket: CollabSocket): number {
  const conn = internals(socket.conn);
  let total = 0;
  for (const packet of conn.writeBuffer ?? []) total += packetBytes(packet.data);
  return total + (conn.transport?.socket?.bufferedAmount ?? 0);
}

/**
 * Closes a WebSocket without waiting for the peer. A close is a handshake: the close frame
 * is queued behind everything already queued, and the peer must answer it, so a client
 * that does not read keeps the connection, and the memory queued for it, for as long as
 * `ws` waits (30 seconds) and Engine.IO's ping timeout (45 seconds by default).
 */
export function terminateTransport(conn: unknown): void {
  internals(conn).transport?.socket?.terminate?.();
}

/** Disconnects a socket and frees what is queued for it at once. */
export function dropSocket(socket: CollabSocket): void {
  socket.disconnect(true);
  terminateTransport(socket.conn);
}
