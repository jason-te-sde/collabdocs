# 0006. Persistence as an update log with snapshots

Status: accepted. The mechanics (locking, compaction, unloading) are in [0003](0003-collab-server.md).

## Context

A Yjs document is the merge of every update ever applied to it. The server must make each accepted edit durable quickly, load a document fast when someone opens it, bound the storage of a document that has been edited for years, and work with several collab instances that each hold a copy and share one PostgreSQL database.

## Decision

Two tables, owned by the Prisma schema:

- `DocumentUpdate` is an append-only log: one row per update that changed the document, with a per-document `seq` that only increases. A trigger refuses `UPDATE`; only compaction deletes rows, after folding them into a snapshot.
- `DocumentSnapshot` holds the folded state (`Y.encodeStateAsUpdate`) with a `version` and `upToSeq`, the highest log `seq` it covers.

Loading reads the newest snapshot and the log rows after it in one `REPEATABLE READ` transaction. After a number of updates or a time since the first uncompacted one, a compaction writes a new snapshot, deletes the log rows it covers and the older snapshots, in one transaction under a per-document advisory lock. Only an update that actually changed the in-memory `Y.Doc` is appended. The instance that received an update is the only one that appends it.

## Consequences

- An edit is durable after one small insert, not after rewriting the whole document.
- Loading cost is one snapshot plus a bounded tail; storage is bounded by the document's size plus at most the compaction threshold of updates.
- `seq` is strictly increasing for the life of the document, across compactions and instances, because the snapshot records `upToSeq`. A fully trimmed log does not restart at 1.
- The log can be inspected and replayed with plain SQL, and an instance that missed a relay message repairs itself by reading rows past its cursor.
- There is a window between applying an update in memory and its commit in which a crash loses it on the server. The client still has it and sends it again at the next sync handshake, so the loss is not user-visible while the client is open.
- History is not kept: after compaction, older states cannot be reconstructed. There is no version history feature in this version.
- Documents are capped by `COLLAB_MAX_DOCUMENT_BYTES` (snapshot plus log), because the whole state is loaded into memory.

## Alternatives rejected

- **One row per document, rewritten on every change.** Every keystroke would write the whole state, and two instances writing at once would overwrite each other.
- **Log only, no snapshots.** Loading time and storage grow without bound.
- **Snapshots only, on a timer.** An edit between two snapshots is lost in a crash, and the clients would have to be trusted to resend it.
- **Compacting from an instance's memory.** Several instances may hold copies that lag; compaction reads the database, which is the one place that has everything.
- **An object store for snapshots.** One more system to run and to keep consistent with the log, for documents that are capped at 16 MiB.
