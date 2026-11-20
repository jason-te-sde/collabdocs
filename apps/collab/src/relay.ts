import { MAC_BYTES, macMatches, messageMac } from "@collabdocs/shared/redis-auth";
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
 * The frame carried on the relay channel: the message, then an HMAC-SHA256 over it
 * made with the shared secret, so that a publisher without the secret cannot inject
 * updates. Binary, because JSON would turn every Yjs update into an array of numbers.
 */
export function encodeRelay(message: RelayMessage, secret: string): Buffer {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, KINDS.indexOf(message.kind));
  encoding.writeVarString(encoder, message.from);
  encoding.writeVarString(encoder, message.documentId);
  encoding.writeVarString(encoder, message.userId ?? "");
  encoding.writeVarUint8Array(encoder, message.data);
  const body = Buffer.from(encoding.toUint8Array(encoder));
  return Buffer.concat([body, messageMac(secret, "relay", body)]);
}

/** Returns null for a frame that is not well formed or whose HMAC does not match. */
export function decodeRelay(frame: Uint8Array, secret: string): RelayMessage | null {
  if (frame.byteLength <= MAC_BYTES) return null;
  const body = frame.subarray(0, frame.byteLength - MAC_BYTES);
  const tag = frame.subarray(frame.byteLength - MAC_BYTES);
  if (!macMatches(messageMac(secret, "relay", body), tag)) return null;
  try {
    const decoder = decoding.createDecoder(body);
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
