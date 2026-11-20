import { randomUUID } from "node:crypto";
import { isRole, type Role } from "@collabdocs/shared";
import pg from "pg";
import * as Y from "yjs";

export interface StoredUpdate {
  seq: number;
  data: Uint8Array;
}

export interface StoredState {
  /** The newest snapshot, or null when there is none or the reader already has it. */
  snapshot: Uint8Array | null;
  /** The log entries after the snapshot (and after the reader's cursor), in seq order. */
  updates: StoredUpdate[];
  /** The highest seq the result covers; a reader passes it back as its next cursor. */
  lastSeq: number;
}

export interface CompactionResult {
  version: number;
  upToSeq: number;
  folded: number;
}

const APPEND_CHUNK = 500;

const LATEST_SNAPSHOT =
  'SELECT "state", "version", "upToSeq"::text AS "upToSeq" FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "version" DESC LIMIT 1';
const LOG_AFTER =
  'SELECT "seq"::text AS seq_text, "data" FROM "DocumentUpdate" WHERE "documentId" = $1 AND "seq" > $2 ORDER BY "seq"';

interface SnapshotRow {
  state: Buffer;
  version: number;
  upToSeq: string;
}
interface LogRow {
  seq_text: string;
  data: Buffer;
}

/**
 * PostgreSQL persistence for one collab server: the append-only update log and
 * the snapshots, in the tables that apps/web's Prisma schema owns.
 *
 * Every write for a document runs under a per-document advisory lock inside one
 * transaction, so two instances never assign the same seq and a compaction never
 * runs between an append's read of the highest seq and its insert.
 */
export class DocumentStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    // An idle client that errors (the database restarted) must not crash the process.
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** The role a user holds on a document right now, or null when they are not a member. */
  async role(documentId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      'SELECT "role"::text AS role FROM "Membership" WHERE "documentId" = $1 AND "userId" = $2',
      [documentId, userId],
    );
    const role = rows[0]?.role;
    return isRole(role) ? role : null;
  }

  /** Every member's role, for the periodic re-check of connected sockets. */
  async roles(documentId: string): Promise<Map<string, Role>> {
    const { rows } = await this.pool.query<{ userId: string; role: string }>(
      'SELECT "userId", "role"::text AS role FROM "Membership" WHERE "documentId" = $1',
      [documentId],
    );
    const roles = new Map<string, Role>();
    for (const row of rows) if (isRole(row.role)) roles.set(row.userId, row.role);
    return roles;
  }

  /** What the document occupies: the newest snapshot plus the log, in bytes. */
  async storedBytes(documentId: string): Promise<number> {
    const { rows } = await this.pool.query<{ bytes: string }>(
      `SELECT (
         COALESCE((SELECT SUM(octet_length("data")) FROM "DocumentUpdate" WHERE "documentId" = $1), 0)
         + COALESCE((SELECT octet_length("state") FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "version" DESC LIMIT 1), 0)
       )::text AS bytes`,
      [documentId],
    );
    return Number(rows[0]?.bytes ?? 0);
  }

  /**
   * The state a reader with cursor `afterSeq` is missing. The snapshot and the log
   * come from one database snapshot, so a compaction cannot fall between them.
   * Pass -1 to read everything.
   */
  async read(documentId: string, afterSeq: number): Promise<StoredState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snap = await client.query<SnapshotRow>(LATEST_SNAPSHOT, [documentId]);
      const snapshotRow = snap.rows[0];
      const snapshotSeq = snapshotRow ? Number(snapshotRow.upToSeq) : 0;
      const useSnapshot = snapshotRow !== undefined && snapshotSeq > afterSeq;
      const log = await client.query<LogRow>(LOG_AFTER, [
        documentId,
        Math.max(afterSeq, snapshotSeq),
      ]);
      await client.query("COMMIT");
      const updates = log.rows.map((r) => ({
        seq: Number(r.seq_text),
        data: new Uint8Array(r.data),
      }));
      return {
        snapshot: useSnapshot ? new Uint8Array(snapshotRow.state) : null,
        updates,
        lastSeq: Math.max(afterSeq, snapshotSeq, updates.at(-1)?.seq ?? 0),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Appends updates in order, in one transaction; returns the seq of the last one. */
  async append(documentId: string, updates: Uint8Array[]): Promise<number> {
    if (updates.length === 0) throw new Error("nothing to append");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [documentId]);
      const base = await client.query<{ base: string }>(
        `SELECT GREATEST(
           COALESCE((SELECT MAX("seq") FROM "DocumentUpdate" WHERE "documentId" = $1), 0),
           COALESCE((SELECT MAX("upToSeq") FROM "DocumentSnapshot" WHERE "documentId" = $1), 0)
         )::text AS base`,
        [documentId],
      );
      let seq = Number(base.rows[0]?.base ?? 0);
      for (let i = 0; i < updates.length; i += APPEND_CHUNK) {
        const chunk = updates.slice(i, i + APPEND_CHUNK);
        const values: unknown[] = [documentId];
        const tuples = chunk.map((data) => {
          seq += 1;
          values.push(seq, Buffer.from(data));
          return `($1, $${values.length - 1}, $${values.length})`;
        });
        await client.query(
          `INSERT INTO "DocumentUpdate" ("documentId", "seq", "data") VALUES ${tuples.join(", ")}`,
          values,
        );
      }
      await client.query("COMMIT");
      return seq;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Folds the snapshot and the log into a new snapshot and trims the log behind
   * it. Reads from the database, not from any instance's memory, so it is right
   * whichever instance runs it. Returns null when the log is empty.
   */
  async compact(documentId: string): Promise<CompactionResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [documentId]);
      const snap = await client.query<SnapshotRow>(LATEST_SNAPSHOT, [documentId]);
      const previous = snap.rows[0];
      const log = await client.query<LogRow>(LOG_AFTER, [
        documentId,
        previous ? Number(previous.upToSeq) : 0,
      ]);
      const last = log.rows.at(-1);
      if (!last) {
        await client.query("ROLLBACK");
        return null;
      }
      const doc = new Y.Doc();
      if (previous) Y.applyUpdate(doc, new Uint8Array(previous.state));
      for (const row of log.rows) Y.applyUpdate(doc, new Uint8Array(row.data));
      const state = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      const version = (previous?.version ?? 0) + 1;
      const upToSeq = Number(last.seq_text);
      await client.query(
        'INSERT INTO "DocumentSnapshot" ("id", "documentId", "version", "state", "upToSeq") VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), documentId, version, state, upToSeq],
      );
      await client.query('DELETE FROM "DocumentUpdate" WHERE "documentId" = $1 AND "seq" <= $2', [
        documentId,
        upToSeq,
      ]);
      await client.query(
        'DELETE FROM "DocumentSnapshot" WHERE "documentId" = $1 AND "version" < $2',
        [documentId, version],
      );
      await client.query("COMMIT");
      return { version, upToSeq, folded: log.rows.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
