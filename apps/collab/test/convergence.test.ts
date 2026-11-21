import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  cleanup,
  closeDb,
  createDocument,
  launch,
  mintToken,
  resetDb,
  snapshotRows,
  updateRows,
  waitFor,
  type Fixture,
} from "./support";
import type { CollabServer } from "../src/index";

/**
 * Property test: whatever several clients do to one document, in whatever order the
 * server receives it, they all end with the same document, the database holds that
 * document, and nothing a client typed is lost.
 *
 * Each client inserts, deletes and formats whole tokens (`[c1:7]`) in a `Y.Text`, and inserts and
 * deletes paragraphs (`Y.XmlElement`s holding one token) in a `Y.XmlFragment`, the structure the
 * editor's TipTap binding produces; so "input" has an
 * exact meaning: every inserted token that no client deleted must be in the final text
 * exactly once, and every deleted token must be gone. Clients hold their updates back
 * and release them late, in random order, sometimes twice (the server then has to hold
 * updates whose predecessors have not arrived), receive what the server relays late and in random
 * order too (held updates are applied shuffled, a part at a time), go offline and come back through a new
 * handshake.
 *
 * To reproduce a failure: FC_SEED=<seed> FC_RUNS=<runs> npx vitest run test/convergence.test.ts
 * (both numbers are printed at the start of the run and again in the failure message).
 */

const SERVER_ORIGIN = Symbol("server");
const CLIENTS = 3;
const TOKEN = /\[c\d+:\d+\]/g;
const PARAGRAPH_TOKEN = /\[p\d+:\d+\]/g;

type Op =
  | { kind: "insert"; client: number; at: number }
  | { kind: "delete"; client: number; at: number }
  | { kind: "format"; client: number; at: number; span: number; bold: boolean }
  | { kind: "flush"; client: number; seed: number; partial: boolean }
  | { kind: "deliver"; client: number; seed: number; partial: boolean }
  | { kind: "paraInsert"; client: number; at: number }
  | { kind: "paraDelete"; client: number; at: number }
  | { kind: "disconnect"; client: number }
  | { kind: "reconnect"; client: number }
  | { kind: "pause"; ms: number };

const client = fc.integer({ min: 0, max: CLIENTS - 1 });
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("deliver" as const),
      client,
      seed: fc.integer(),
      partial: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("paraInsert" as const), client, at: fc.nat() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("paraDelete" as const), client, at: fc.nat() }),
  },
  {
    weight: 6,
    arbitrary: fc.record({ kind: fc.constant("insert" as const), client, at: fc.nat() }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("delete" as const), client, at: fc.nat() }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("format" as const),
      client,
      at: fc.nat(),
      span: fc.nat(),
      bold: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("flush" as const),
      client,
      seed: fc.integer(),
      partial: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("disconnect" as const), client }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reconnect" as const), client }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("pause" as const), ms: fc.nat(12) }) },
);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A client that keeps its own Y.Doc across disconnects and sends only when told to. */
class PropertyClient {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("text");
  /** The structure TipTap's Collaboration extension produces: paragraphs in the `default` fragment. */
  readonly fragment = this.doc.getXmlFragment("default");
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private socket: Socket | null = null;
  private outbox: Uint8Array[] = [];
  private synced = false;
  private counter = 0;
  /** Updates received from the server and not yet applied: the receiving side's delay and disorder. */
  private held: Uint8Array[] = [];
  private holding = true;
  /** Once set, updates go out as they are made, as in the browser editor. */
  private immediate = false;

  constructor(
    readonly index: number,
    private readonly server: CollabServer,
    private readonly fixture: Fixture,
    private readonly who: string,
    private readonly role: "owner" | "editor",
  ) {
    this.awareness.setLocalState({ user: { name: who } });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // While offline nothing is queued: the next handshake carries the difference.
      if (origin === SERVER_ORIGIN || !this.socket?.connected) return;
      if (this.immediate) this.send(update);
      else this.outbox.push(update);
    });
  }

  get online(): boolean {
    return this.socket?.connected ?? false;
  }

  async connect(): Promise<void> {
    const token = await mintToken(
      this.fixture.documentId,
      this.fixture.users[this.who]!,
      this.role,
    );
    this.synced = false;
    this.outbox = [];
    this.held = [];
    const socket = connect(`http://127.0.0.1:${this.server.port}`, {
      auth: { token, documentId: this.fixture.documentId },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    this.socket = socket;
    socket.on("connect", () => {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.emit("sync", encoding.toUint8Array(encoder));
    });
    socket.on("sync", (data: Uint8Array) => {
      const bytes = new Uint8Array(data);
      // Only updates are held; the handshake messages must be answered at once.
      if (
        this.holding &&
        decoding.readVarUint(decoding.createDecoder(bytes)) === syncProtocol.messageYjsUpdate
      ) {
        this.held.push(bytes);
        return;
      }
      const encoder = encoding.createEncoder();
      const type = syncProtocol.readSyncMessage(
        decoding.createDecoder(bytes),
        encoder,
        this.doc,
        SERVER_ORIGIN,
      );
      if (type === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(encoder) > 0) socket.emit("sync", encoding.toUint8Array(encoder));
    });
    socket.on("awareness", (data: Uint8Array) => {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(data), SERVER_ORIGIN);
    });
    await waitFor(() => this.synced, `client ${this.index} to sync`, 10_000);
  }

  disconnect(): void {
    this.socket?.close();
    this.outbox = [];
  }

  close(): void {
    this.disconnect();
    this.awareness.destroy();
  }

  private send(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.socket?.emit("sync", encoding.toUint8Array(encoder));
  }

  /** Releases held updates in random order, some twice. `partial` keeps a random part back. */
  flush(rng: () => number, partial: boolean): void {
    if (!this.online) return;
    const held = this.outbox;
    this.outbox = [];
    for (let i = held.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [held[i], held[j]] = [held[j]!, held[i]!];
    }
    for (const update of held) {
      if (partial && rng() < 0.5) {
        this.outbox.push(update);
        continue;
      }
      this.send(update);
      if (rng() < 0.2) this.send(update);
    }
  }

  private apply(bytes: Uint8Array): void {
    syncProtocol.readSyncMessage(
      decoding.createDecoder(bytes),
      encoding.createEncoder(),
      this.doc,
      SERVER_ORIGIN,
    );
  }

  /** Applies received updates late and in random order; `partial` keeps a random part waiting. */
  deliver(rng: () => number, partial: boolean): void {
    const held = this.held;
    this.held = [];
    for (let i = held.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [held[i], held[j]] = [held[j]!, held[i]!];
    }
    for (const bytes of held) {
      if (partial && rng() < 0.5) this.held.push(bytes);
      else this.apply(bytes);
    }
  }

  /**
   * Everything held goes out, in the order it was made, and from now on every update is
   * sent at once. Yjs makes updates of its own while it applies what it receives (it removes
   * formatting marks that no longer do anything), so holding back would leave some behind.
   */
  release(): void {
    this.immediate = true;
    this.holding = false;
    this.deliver(() => 0, false);
    const held = this.outbox;
    this.outbox = [];
    for (const update of held) this.send(update);
  }

  /** The tokens of the local text with the offset at which each starts. */
  private tokens(): Array<{ id: string; start: number; end: number }> {
    return [...this.text.toString().matchAll(TOKEN)].map((m) => ({
      id: m[0],
      start: m.index,
      end: m.index + m[0].length,
    }));
  }

  insert(at: number, inserted: Set<string>): void {
    const tokens = this.tokens();
    const boundary = at % (tokens.length + 1);
    const offset = boundary === 0 ? 0 : tokens[boundary - 1]!.end;
    this.counter += 1;
    const id = `[c${this.index}:${this.counter}]`;
    inserted.add(id);
    this.text.insert(offset, id);
  }

  remove(at: number, deleted: Set<string>): void {
    const tokens = this.tokens();
    if (tokens.length === 0) return;
    const token = tokens[at % tokens.length]!;
    deleted.add(token.id);
    this.text.delete(token.start, token.end - token.start);
  }

  paragraphInsert(at: number, inserted: Set<string>): void {
    this.counter += 1;
    const id = `[p${this.index}:${this.counter}]`;
    inserted.add(id);
    this.doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(id)]);
      this.fragment.insert(at % (this.fragment.length + 1), [paragraph]);
    });
  }

  paragraphDelete(at: number, deleted: Set<string>): void {
    if (this.fragment.length === 0) return;
    const index = at % this.fragment.length;
    const id = this.fragment.get(index).toString().match(PARAGRAPH_TOKEN);
    if (id?.length !== 1) throw new Error(`a paragraph without exactly one token: ${id}`);
    deleted.add(id[0]);
    this.fragment.delete(index, 1);
  }

  format(at: number, span: number, bold: boolean): void {
    const tokens = this.tokens();
    if (tokens.length === 0) return;
    const first = at % tokens.length;
    const last = Math.min(tokens.length - 1, first + (span % 3));
    const start = tokens[first]!.start;
    this.text.format(start, tokens[last]!.end - start, { bold: bold ? true : null });
  }
}

function delta(doc: Y.Doc): string {
  return JSON.stringify(doc.getText("text").toDelta());
}

async function storedDoc(documentId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const snapshot of await snapshotRows(documentId)) Y.applyUpdate(doc, snapshot.state);
  for (const row of await updateRows(documentId)) Y.applyUpdate(doc, row.data);
  return doc;
}

async function play(server: CollabServer, ops: Op[]): Promise<void> {
  const fixture = await createDocument({ a: "editor", b: "editor" });
  const roles = [
    ["owner", "owner"],
    ["a", "editor"],
    ["b", "editor"],
  ] as const;
  const clients = roles.map(
    ([who, role], index) => new PropertyClient(index, server, fixture, who, role),
  );
  const inserted = new Set<string>();
  const deleted = new Set<string>();
  const paragraphsInserted = new Set<string>();
  const paragraphsDeleted = new Set<string>();
  try {
    await Promise.all(clients.map((c) => c.connect()));
    for (const op of ops) {
      const c = clients[op.kind === "pause" ? 0 : op.client]!;
      switch (op.kind) {
        case "insert":
          c.insert(op.at, inserted);
          break;
        case "delete":
          c.remove(op.at, deleted);
          break;
        case "format":
          c.format(op.at, op.span, op.bold);
          break;
        case "flush":
          c.flush(random(op.seed), op.partial);
          break;
        case "deliver":
          c.deliver(random(op.seed), op.partial);
          break;
        case "paraInsert":
          c.paragraphInsert(op.at, paragraphsInserted);
          break;
        case "paraDelete":
          c.paragraphDelete(op.at, paragraphsDeleted);
          break;
        case "disconnect":
          c.disconnect();
          break;
        case "reconnect":
          if (!c.online) await c.connect();
          break;
        case "pause":
          await new Promise((resolve) => setTimeout(resolve, op.ms));
          break;
      }
    }
    // Everyone comes back, everything held is released, and the system settles.
    for (const c of clients) if (!c.online) await c.connect();
    for (const c of clients) c.release();

    const expected = [...inserted].filter((id) => !deleted.has(id)).sort();
    // "The same state" means the same structs and the same deletions: equal snapshots.
    // Comparing text alone could succeed while an update is still on its way.
    const same = (a: Y.Doc, b: Y.Doc) => Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b));
    const settled = () => clients.every((c) => same(c.doc, clients[0]!.doc));
    await waitFor(settled, "the clients to converge", 15_000).catch(() => {});
    const finalText = clients[0]!.text.toString();
    await waitFor(
      async () => same(await storedDoc(fixture.documentId), clients[0]!.doc),
      "the database to hold the final document",
      15_000,
    ).catch(() => {});

    for (const c of clients) {
      expect(c.text.toString(), `client ${c.index} text`).toBe(finalText);
      expect(delta(c.doc), `client ${c.index} formatting`).toBe(delta(clients[0]!.doc));
    }
    const stored = await storedDoc(fixture.documentId);
    expect(stored.getText("text").toString(), "the database text").toBe(finalText);
    expect(delta(stored), "the database formatting").toBe(delta(clients[0]!.doc));
    // Nothing typed is lost, nothing deleted comes back, nothing appears twice.
    expect((finalText.match(TOKEN) ?? []).sort(), "tokens in the final text").toEqual(expected);
    // The same for the paragraphs of the fragment.
    const fragmentText = clients[0]!.fragment.toString();
    for (const c of clients) {
      expect(c.fragment.toString(), `client ${c.index} paragraphs`).toBe(fragmentText);
    }
    expect(stored.getXmlFragment("default").toString(), "the database paragraphs").toBe(
      fragmentText,
    );
    expect((fragmentText.match(PARAGRAPH_TOKEN) ?? []).sort(), "tokens in the paragraphs").toEqual(
      [...paragraphsInserted].filter((id) => !paragraphsDeleted.has(id)).sort(),
    );
    // Only tokens: no stray characters.
    expect(finalText.replace(TOKEN, ""), "text outside the tokens").toBe("");
  } finally {
    for (const c of clients) c.close();
  }
}

beforeEach(resetDb);
afterAll(async () => {
  await cleanup();
  await closeDb();
});

const runs = Number(process.env.FC_RUNS ?? 25);
const seed = process.env.FC_SEED
  ? Number(process.env.FC_SEED)
  : Math.floor(Math.random() * 2 ** 31);

/** If a run is slow because something hangs, the failure still names the seed. */
const PARAMETERS = { interruptAfterTimeLimit: 100_000, markInterruptAsFailure: true } as const;

describe("convergence", () => {
  beforeAll(() => {
    console.log(`convergence: FC_SEED=${seed} FC_RUNS=${runs}`);
  });

  it("three clients with random operations, delivery order, delays and reconnects converge", async () => {
    // A server for the whole property: each run uses its own document.
    const server = await launch({ redis: true });
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(opArbitrary, { minLength: 5, maxLength: 30 }), async (ops) => {
          await resetDb();
          await play(server, ops);
        }),
        { numRuns: runs, seed, endOnFailure: false, ...PARAMETERS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nReproduce: FC_SEED=${seed} FC_RUNS=${runs} npx vitest run test/convergence.test.ts`,
        { cause: error },
      );
    }
  }, 180_000);

  it("a client that is offline for a whole session of edits merges on reconnect", async () => {
    const server = await launch({ redis: true });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ client: fc.integer({ min: 0, max: 2 }), at: fc.nat() }), {
            minLength: 3,
            maxLength: 20,
          }),
          async (edits) => {
            await resetDb();
            const ops: Op[] = [
              { kind: "disconnect", client: 0 },
              ...edits.flatMap((e): Op[] => [
                { kind: "insert", client: e.client, at: e.at },
                { kind: "flush", client: e.client, seed: e.at, partial: false },
              ]),
              { kind: "reconnect", client: 0 },
            ];
            await play(server, ops);
          },
        ),
        { numRuns: Math.max(5, Math.floor(runs / 2)), seed, endOnFailure: false, ...PARAMETERS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n\nReproduce: FC_SEED=${seed} FC_RUNS=${runs} npx vitest run test/convergence.test.ts`,
        { cause: error },
      );
    }
  }, 180_000);
});
