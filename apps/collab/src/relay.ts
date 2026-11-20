import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { RelayKind } from "./types";

export interface RelayMessage {
  /** The instance that sent it, so that it can ignore its own copy. */
  from: string;
  documentId: string;
  kind: RelayKind;
  data: Uint8Array;
  /** For awareness: the user whose sockets the update came from. Awareness ids belong to a user. */
  userId?: string;
}

const KINDS: readonly RelayKind[] = ["update", "awareness"];

/**
 * The frame carried on the relay channel. Binary, because the Socket.IO adapter's
 * own server-to-server messages are JSON, which would turn every Yjs update
 * into an array of numbers.
 */
export function encodeRelay(message: RelayMessage): Buffer {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, KINDS.indexOf(message.kind));
  encoding.writeVarString(encoder, message.from);
  encoding.writeVarString(encoder, message.documentId);
  encoding.writeVarString(encoder, message.userId ?? "");
  encoding.writeVarUint8Array(encoder, message.data);
  return Buffer.from(encoding.toUint8Array(encoder));
}

/** Returns null for a frame that is not well formed. */
export function decodeRelay(frame: Uint8Array): RelayMessage | null {
  try {
    const decoder = decoding.createDecoder(frame);
    const kind = KINDS[decoding.readUint8(decoder)];
    if (!kind) return null;
    const from = decoding.readVarString(decoder);
    const documentId = decoding.readVarString(decoder);
    const userId = decoding.readVarString(decoder);
    const data = decoding.readVarUint8Array(decoder);
    return { from, documentId, kind, data, ...(userId ? { userId } : {}) };
  } catch {
    return null;
  }
}
