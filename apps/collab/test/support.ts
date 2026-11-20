import { randomUUID } from "node:crypto";
import { signCollabToken, type Role } from "@collabdocs/shared";
import { Redis } from "ioredis";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import pg from "pg";
import { io as connect, type Socket } from "socket.io-client";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { startCollabServer, type CollabServer } from "../src/index";
import type { Logger } from "../src/logger";

export const TOKEN_SECRET = "test-collab-secret-0123456789-abcdefghij";

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; the tests need a PostgreSQL database");
  // The tests delete every row. Refuse to run against anything that is not a test database.
  const name = new URL(url).pathname.slice(1);
  if (!name.includes("test")) {
    throw new Error(`refusing to run against database "${name}": its name must contain "test"`);
  }
  return url;
}

export function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set; these tests need a Redis server");
  return url;
}

// ---- database ------------------------------------------------------------------------

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: databaseUrl(), max: 4 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

export async function resetDb(): Promise<void> {
  await db().query(
    'TRUNCATE "DocumentUpdate", "DocumentSnapshot", "Membership", "Document", "Account", "Session", "VerificationToken", "User" CASCADE',
  );
}

export interface Fixture {
  documentId: string;
  /** user id by name */
  users: Record<string, string>;
}

/** A document owned by "owner", plus one member per entry of `members` (name to role). */
export async function createDocument(
  members: Record<string, Exclude<Role, "owner">> = { editor: "editor", viewer: "viewer" },
): Promise<Fixture> {
  const documentId = `doc_${randomUUID()}`;
  const users: Record<string, string> = {};
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (const name of ["owner", ...Object.keys(members)]) {
      const id = `user_${randomUUID()}`;
      users[name] = id;
      await client.query('INSERT INTO "User" ("id", "email", "name") VALUES ($1, $2, $3)', [
        id,
        `${name}-${id}@example.test`,
        name,
      ]);
    }
    await client.query(
      'INSERT INTO "Document" ("id", "title", "ownerId", "updatedAt") VALUES ($1, $2, $3, now())',
      [documentId, "Test document", users.owner],
    );
    await client.query(
      'INSERT INTO "Membership" ("id", "documentId", "userId", "role") VALUES ($1, $2, $3, $4::"Role")',
      [randomUUID(), documentId, users.owner, "owner"],
    );
    for (const [name, role] of Object.entries(members)) {
      await client.query(
        'INSERT INTO "Membership" ("id", "documentId", "userId", "role") VALUES ($1, $2, $3, $4::"Role")',
        [randomUUID(), documentId, users[name], role],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { documentId, users };
}

export async function removeMember(documentId: string, userId: string): Promise<void> {
  await db().query('DELETE FROM "Membership" WHERE "documentId" = $1 AND "userId" = $2', [
    documentId,
    userId,
  ]);
}

export async function setRole(documentId: string, userId: string, role: Role): Promise<void> {
  await db().query(
    'UPDATE "Membership" SET "role" = $3::"Role" WHERE "documentId" = $1 AND "userId" = $2',
    [documentId, userId, role],
  );
}

export async function updateRows(
  documentId: string,
): Promise<Array<{ seq: number; data: Buffer }>> {
  const { rows } = await db().query<{ seq_text: string; data: Buffer }>(
    'SELECT "seq"::text AS seq_text, "data" FROM "DocumentUpdate" WHERE "documentId" = $1 ORDER BY "seq"',
    [documentId],
  );
  return rows.map((r) => ({ seq: Number(r.seq_text), data: r.data }));
}

export async function snapshotRows(
  documentId: string,
): Promise<Array<{ version: number; upToSeq: number; state: Buffer }>> {
  const { rows } = await db().query<{ version: number; upToSeq: string; state: Buffer }>(
    'SELECT "version", "upToSeq"::text AS "upToSeq", "state" FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "version"',
    [documentId],
  );
  return rows.map((r) => ({ version: r.version, upToSeq: Number(r.upToSeq), state: r.state }));
}

/** The document as the database holds it: the snapshot plus the log. */
export async function storedText(documentId: string, field = "text"): Promise<string> {
  const doc = new Y.Doc();
  for (const snapshot of await snapshotRows(documentId)) Y.applyUpdate(doc, snapshot.state);
  for (const row of await updateRows(documentId)) Y.applyUpdate(doc, row.data);
  return doc.getText(field).toString();
}

// ---- servers ---------------------------------------------------------------------------

export interface CapturedLogger extends Logger {
  records: Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  find(message: string): Array<Record<string, unknown>>;
}

export function captureLogger(): CapturedLogger {
  const records: CapturedLogger["records"] = [];
  const add =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      records.push({ level, message, fields });
    };
  return {
    records,
    find: (message) => records.filter((r) => r.message === message).map((r) => r.fields),
    info: add("info"),
    warn: add("warn"),
    error: add("error"),
  };
}

const RUN = randomUUID().slice(0, 8);
const started: CollabServer[] = [];
const clients: TestClient[] = [];
const redisClients: Redis[] = [];

type LaunchOptions = Partial<Parameters<typeof startCollabServer>[0]> & { redis?: boolean };

/** Starts an in-process server on a random port. Each test file gets its own Redis channels. */
export async function launch(
  options: LaunchOptions = {},
): Promise<CollabServer & { logs: CapturedLogger }> {
  const { redis, ...rest } = options;
  const logs = captureLogger();
  const server = await startCollabServer({
    port: 0,
    host: "127.0.0.1",
    databaseUrl: databaseUrl(),
    tokenSecret: TOKEN_SECRET,
    logger: logs,
    adapterKey: adapterKey(),
    membershipChannel: `test-membership-${RUN}`,
    // Quiet by default: tests that look at a timer set their own.
    persistence: {
      reconcileIntervalMs: 60_000,
      membershipRecheckMs: 60_000,
      unloadGraceMs: 60_000,
    },
    ...(redis ? { redisUrl: redisUrl() } : {}),
    ...rest,
  });
  started.push(server);
  return Object.assign(server, { logs });
}

export function adapterKey(): string {
  return `test-io-${RUN}`;
}

export function membershipChannel(): string {
  return `test-membership-${RUN}`;
}

export async function publishMembership(message: string): Promise<void> {
  const publisher = new Redis(redisUrl());
  redisClients.push(publisher);
  await publisher.publish(membershipChannel(), message);
}

/** A Redis connection that the test closes at cleanup. */
export function redisClient(): Redis {
  const client = new Redis(redisUrl());
  redisClients.push(client);
  return client;
}

export async function cleanup(): Promise<void> {
  for (const client of clients.splice(0)) client.close();
  for (const server of started.splice(0)) await server.close();
  for (const redis of redisClients.splice(0)) redis.disconnect();
}

// ---- clients ------------------------------------------------------------------------

export async function mintToken(
  documentId: string,
  userId: string,
  role: Role,
  extra: { ttlSeconds?: number; now?: number; secret?: string } = {},
): Promise<string> {
  const { token } = await signCollabToken({
    documentId,
    userId,
    role,
    secret: extra.secret ?? TOKEN_SECRET,
    ...(extra.ttlSeconds === undefined ? {} : { ttlSeconds: extra.ttlSeconds }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
  return token;
}

export interface ClientOptions {
  /** The role to put in the token. Defaults to the member's real role. */
  tokenRole?: Role;
  /** Do not send local edits on their own; the test sends them with `forceSend`. */
  manual?: boolean;
  token?: string;
  tokenDocumentId?: string;
  /** Open the socket but do not wait for the first sync. */
  noWait?: boolean;
  /** Edits made before connecting, as an offline client would have. */
  offline?: (doc: Y.Doc) => void;
}

/**
 * A headless collaboration client: a Y.Doc and an Awareness spoken over
 * Socket.IO with the y-protocols messages, as the editor will do.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly rejected: Array<{ event: string; reason: string }> = [];
  readonly revoked: Array<{ reason: string }> = [];
  readonly connectErrors: Array<{ message: string; code?: string }> = [];
  socket!: Socket;
  synced = false;
  disconnects = 0;
  private readonly server = Symbol("server");

  private constructor(private readonly manual: boolean) {}

  static async connect(
    server: CollabServer,
    fixture: Fixture,
    who: string,
    role: Role,
    options: ClientOptions = {},
  ): Promise<TestClient> {
    const client = new TestClient(options.manual ?? false);
    clients.push(client);
    const userId = fixture.users[who];
    if (!userId) throw new Error(`no user ${who} in the fixture`);
    const token =
      options.token ??
      (await mintToken(
        options.tokenDocumentId ?? fixture.documentId,
        userId,
        options.tokenRole ?? role,
      ));
    options.offline?.(client.doc);
    client.open(server.port, fixture.documentId, token);
    if (!options.noWait) await client.waitSynced();
    return client;
  }

  private open(port: number, documentId: string, token: string): void {
    this.awareness.setLocalState(null);
    this.socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token, documentId },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    this.socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
      this.connectErrors.push({
        message: error.message,
        ...(error.data?.code ? { code: error.data.code } : {}),
      });
    });
    this.socket.on("disconnect", () => {
      this.disconnects += 1;
    });
    this.socket.on("rejected", (notice) => this.rejected.push(notice));
    this.socket.on("revoked", (notice) => this.revoked.push(notice));
    this.socket.on("connect", () => {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.socket.emit("sync", encoding.toUint8Array(encoder));
    });
    this.socket.on("sync", (data: Uint8Array) => {
      const encoder = encoding.createEncoder();
      const type = syncProtocol.readSyncMessage(
        decoding.createDecoder(new Uint8Array(data)),
        encoder,
        this.doc,
        this.server,
      );
      if (type === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(encoder) > 0) this.socket.emit("sync", encoding.toUint8Array(encoder));
    });
    this.socket.on("awareness", (data: Uint8Array) => {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(data), this.server);
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.server || this.manual) return;
      this.forceSend(update);
    });
    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === this.server) return;
        this.socket.emit(
          "awareness",
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            ...added,
            ...updated,
            ...removed,
          ]),
        );
      },
    );
  }

  /** Sends an update message whether or not this client's role allows it. */
  forceSend(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.socket.emit("sync", encoding.toUint8Array(encoder));
  }

  /** Sends a sync step 2 carrying the whole local state. */
  forceSendStep2(): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep2(encoder, this.doc);
    this.socket.emit("sync", encoding.toUint8Array(encoder));
  }

  get text(): string {
    return this.doc.getText("text").toString();
  }

  insert(index: number, value: string): void {
    this.doc.getText("text").insert(index, value);
  }

  append(value: string): void {
    const text = this.doc.getText("text");
    text.insert(text.length, value);
  }

  waitSynced(timeoutMs = 5000): Promise<void> {
    return waitFor(
      () => this.synced,
      `client to sync (errors: ${JSON.stringify(this.connectErrors)})`,
      timeoutMs,
    );
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  close(): void {
    this.socket.close();
    this.awareness.destroy();
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Waits long enough for a message that should NOT arrive to have arrived, if it were going to. */
export function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectErrorOf(
  server: CollabServer,
  fixture: Fixture,
  who: string,
  role: Role,
  options: ClientOptions = {},
): Promise<{ message: string; code?: string }> {
  const client = await TestClient.connect(server, fixture, who, role, { ...options, noWait: true });
  await waitFor(() => client.connectErrors.length > 0, "a refused handshake");
  return client.connectErrors[0]!;
}
