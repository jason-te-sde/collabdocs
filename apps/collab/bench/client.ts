import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { io as connect, type Socket } from "socket.io-client";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/** Milliseconds on a clock that is comparable between processes. */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** A growable list of fixed-width rows of numbers. */
export class Rows {
  private data: Float64Array;
  private length = 0;
  constructor(
    readonly width: number,
    initialRows = 4096,
  ) {
    this.data = new Float64Array(width * initialRows);
  }
  push(...row: number[]): void {
    if (this.length + this.width > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(row, this.length);
    this.length += this.width;
  }
  toArray(): Float64Array {
    return this.data.slice(0, this.length);
  }
}

export interface EditorOptions {
  /** Position among all editors of the run; also names the user and sets the Yjs client id. */
  index: number;
  url: string;
  token: string;
  documentId: string;
  writer: boolean;
  /** Average time between two typed characters while writing. */
  typingIntervalMs: number;
  /** Average time between two cursor moves of an editor that is only reading. */
  readerCursorIntervalMs: number;
  /** Rows [writerClientId, clock, sentAtMs]. */
  sends: Rows;
  /** Rows [receiverIndex, writerClientId, clock, receivedAtMs]. */
  receives: Rows;
}

const SERVER = Symbol("server");
const COLORS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz      ";

/** The Yjs client id of editor `index`. Fixed, so that receivers can tell whose edit arrived. */
export function clientIdOf(index: number): number {
  return 1000 + index;
}

/**
 * A headless editor: a Y.Doc and an Awareness spoken to the collab server with the
 * y-protocols sync and awareness messages over Socket.IO, as the browser editor does.
 * A writer types one character at a time and moves its cursor with every character; a
 * reader only moves its cursor now and then. The awareness object also runs its own
 * 15-second renewal, as in the browser.
 */
export class LoadEditor {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  readonly text: Y.Text;
  socket!: Socket;
  synced = false;
  recording = false;
  disconnects = 0;
  rejections = 0;
  /** Messages received from the server, by event. */
  received = { sync: 0, awareness: 0 };
  connectErrors: string[] = [];
  private cursor: number;
  private timer: NodeJS.Timeout | null = null;
  private typing = false;

  constructor(private readonly options: EditorOptions) {
    this.doc.clientID = clientIdOf(options.index);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.text = this.doc.getText("text");
    this.cursor = 0;
    this.awareness.setLocalState({
      user: { name: `Editor ${options.index}`, color: COLORS[options.index % COLORS.length] },
    });
  }

  /** Opens the socket and resolves when the server's state has arrived. */
  connect(timeoutMs = 30_000): Promise<void> {
    const { url, token, documentId } = this.options;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`editor ${this.options.index} did not sync in ${timeoutMs} ms`)),
        timeoutMs,
      );
      const socket = connect(url, {
        auth: { token, documentId },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
      });
      this.socket = socket;
      socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
        this.connectErrors.push(error.data?.code ?? error.message);
        clearTimeout(timer);
        reject(new Error(`editor ${this.options.index}: ${error.data?.code ?? error.message}`));
      });
      socket.on("disconnect", () => {
        this.disconnects += 1;
      });
      socket.on("rejected", () => {
        this.rejections += 1;
      });
      socket.on("connect", () => {
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep1(encoder, this.doc);
        socket.emit("sync", encoding.toUint8Array(encoder));
        // The awareness state announced to the others, as the editor does when it opens.
        this.sendAwareness([this.doc.clientID]);
      });
      socket.on("sync", (data: Uint8Array) => {
        this.received.sync += 1;
        const encoder = encoding.createEncoder();
        const type = syncProtocol.readSyncMessage(
          decoding.createDecoder(new Uint8Array(data)),
          encoder,
          this.doc,
          SERVER,
        );
        if (type === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          clearTimeout(timer);
          resolve();
        }
        if (encoding.length(encoder) > 0) socket.emit("sync", encoding.toUint8Array(encoder));
      });
      socket.on("awareness", (data: Uint8Array) => {
        this.received.awareness += 1;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(data), SERVER);
      });
      this.doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === SERVER) return;
        // The moment the local change has been applied and is about to be sent.
        const sentAt = nowMs();
        const encoder = encoding.createEncoder();
        syncProtocol.writeUpdate(encoder, update);
        socket.emit("sync", encoding.toUint8Array(encoder));
        if (this.typing) {
          this.options.sends.push(
            this.doc.clientID,
            Y.getState(this.doc.store, this.doc.clientID),
            sentAt,
          );
        }
      });
      this.doc.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.origin !== SERVER || !this.recording) return;
        const receivedAt = nowMs();
        for (const [client, after] of transaction.afterState) {
          if (after !== (transaction.beforeState.get(client) ?? 0)) {
            this.options.receives.push(this.options.index, client, after, receivedAt);
          }
        }
      });
      this.awareness.on(
        "update",
        (
          { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
          origin: unknown,
        ) => {
          // Only our own changes go out, as in the browser editor: a timeout removal of a
          // remote peer is not ours to announce.
          if (origin !== "local") return;
          this.sendAwareness([...added, ...updated, ...removed]);
        },
      );
    });
  }

  private sendAwareness(ids: number[]): void {
    if (!this.socket?.connected) return;
    this.socket.emit("awareness", awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
  }

  private moveCursor(index: number): void {
    const position = Y.createRelativePositionFromTypeIndex(this.text, index);
    const json = Y.relativePositionToJSON(position);
    this.awareness.setLocalStateField("cursor", { anchor: json, head: json });
  }

  /** Starts the behaviour of this editor: typing for a writer, now and then a click for a reader. */
  start(): void {
    if (this.options.writer) {
      this.cursor = Math.floor(Math.random() * (this.text.length + 1));
      this.typing = true;
      this.scheduleNext(this.options.typingIntervalMs, () => this.type());
    } else {
      this.scheduleNext(this.options.readerCursorIntervalMs, () => {
        this.moveCursor(Math.floor(Math.random() * (this.text.length + 1)));
      });
    }
  }

  /** The next action after 0.5 to 1.5 times the average interval. */
  private scheduleNext(averageMs: number, action: () => void): void {
    this.timer = setTimeout(
      () => {
        action();
        if (this.timer) this.scheduleNext(averageMs, action);
      },
      averageMs * (0.5 + Math.random()),
    );
  }

  private type(): void {
    const at = Math.min(this.cursor, this.text.length);
    const character = ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!;
    this.text.insert(at, character);
    this.cursor = at + 1;
    this.moveCursor(this.cursor);
  }

  /** Stops acting; the socket stays open to receive what is still in flight. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.typing = false;
  }

  close(): void {
    this.stop();
    this.socket?.close();
    this.awareness.destroy();
  }
}
