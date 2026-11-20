# 0003. The collaboration server

Status: accepted.

## Context

`apps/collab` keeps the live copy of every open document, relays edits between the people who have it open, makes each edit durable, and refuses what a role does not allow. It must keep working when several instances run behind a load balancer, and it must say what happens when a part of it fails. [0001](0001-monorepo-and-socket-io.md) chose Yjs over Socket.IO; [0002](0002-roles-and-tokens.md) defined the roles and the token. This record is the server.

## Protocol over Socket.IO

One Socket.IO connection serves one document. The client connects with `auth: { token, documentId }` and the server puts the socket in the room `doc:<documentId>`. There are two binary events and two notices.

| Event       | Direction        | Payload                                                                       | Needs                                   |
| ----------- | ---------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| `sync`      | both             | a y-protocols sync message: step 1 (state vector), step 2 (diff) or an update | step 1: `read`; step 2, update: `write` |
| `awareness` | both             | a y-protocols awareness update (cursor, name, colour)                         | `read`                                  |
| `rejected`  | server to client | `{ event, reason }`, reason is `forbidden`, `too_large` or `malformed`        |                                         |
| `revoked`   | server to client | `{ reason }`, then the server closes the socket                               |                                         |

The messages are the y-protocols messages without y-websocket's outer type byte: the event name says what the message is. The names and notices are in `packages/shared/src/collab-protocol.ts`.

**The exchange.** The client sends sync step 1 as soon as it connects, and the server answers with step 2. A socket whose role may write is also sent the server's step 1, so that edits it made offline come back in its step 2. A viewer is not sent a step 1: it has nothing to offer, and its step 2 would be refused. Whoever joins also receives the awareness states already present.

**Step 2 is a write.** A step 2 carries document content exactly like an update, so a viewer's step 2 is rejected like a viewer's update. A client library for viewers must not answer a step 1 with a step 2; the server never sends one to a viewer.

**The handshake** (`io.use`) runs, in order: the token is verified with `verifyCollabToken` from `packages/shared` (signature, issuer, audience, expiry, and that it is for the requested document); the membership is looked up in the database; the number of sockets in the document's room, counted across all instances, must be below the limit. Any failure is a `connect_error` whose `data.code` is `invalid_token`, `not_a_member`, `too_many_connections` or `server_error`; the reason goes to the log and not to the client, and the document is not loaded for a socket that failed. The socket acts with the weaker of the token's role and the membership's current role, so a token issued before a demotion cannot write.

**Every incoming event** is checked on arrival: first the rate limit, then (once the document is loaded) `can(role, action)` for the event, then size and syntax. A refused message is dropped, logged with the document, user, role, event and reason (never the content), and answered with `rejected`. It does not touch the document.

## Persistence

Two tables, owned by the Prisma schema in `apps/web`: `DocumentUpdate`, the append-only log, and `DocumentSnapshot`. The server reads and writes them with `pg` and parameterised SQL (`apps/collab/src/store.ts`).

- **Loading.** The first connection to a document creates a `Y.Doc` and reads the newest snapshot and the log rows after it, in one `REPEATABLE READ` transaction, so a compaction cannot fall between the two reads.
- **Appending.** An update that changed the document is queued and appended in batches. One transaction per batch takes a per-document advisory lock, reads the highest `seq` of the log and of the newest snapshot, and inserts the rows with the next numbers. `seq` therefore increases strictly for the life of the document, across compactions and across instances. Only an update that actually changed the `Y.Doc` is appended: Yjs emits no update for a message that carried nothing new, so a reconnecting client's empty step 2 writes nothing.
- **Compacting.** After `COLLAB_COMPACT_EVERY_UPDATES` appended updates, or `COLLAB_COMPACT_AFTER_MS` after the first uncompacted one, the log is folded into a new snapshot (`Y.encodeStateAsUpdate`) in one transaction under the same lock: insert the snapshot with `version + 1` and `upToSeq` set to the highest folded `seq`, delete the log rows up to it, delete older snapshots. Compaction reads the database, not any instance's memory, so it is right whichever instance runs it and two instances compacting at once are serialised by the lock. `upToSeq` is a column added in the migration `snapshot_covers_seq`; without it, a fully trimmed log would restart `seq` at 1.
- **Unloading.** When the last socket leaves, the document stays in memory for `COLLAB_UNLOAD_GRACE_MS`. A connection inside that window reuses it. Afterwards the queue is written, uncompacted updates are compacted, and the `Y.Doc` is destroyed. On shutdown every loaded document is flushed the same way.

An update is broadcast to the other sockets of the instance as soon as it is applied, and appended to the log right after, in a batch. A crash in that window can lose an update on the server, not on the clients: they still have it, and the sync handshake on reconnect sends what the server lacks. The server is not the only copy until the append has committed.

## Several instances

Each instance holds its own `Y.Doc` for the documents its clients have open. Two instances must (a) keep those copies equal, (b) never both append the same update, and (c) answer a late joiner from a current copy.

**Design.** The instance that receives an update from one of its clients applies it, appends it to the log (the only append of that update), and only after the append commits publishes it on a Redis channel. Every other instance that holds the document applies it with a `remote` transaction origin, which is never appended, and forwards it to its own sockets. Awareness updates take the same path without the append. Because the update is on the channel only once it is in the log, a copy never holds something that the database lacks, and an instance that loads a document after subscribing misses nothing: whatever was published before it subscribed was already in the log it reads.

**The adapter is not enough on its own.** The Socket.IO Redis adapter delivers a broadcast to the sockets of other instances, but it does not put the update into those instances' `Y.Doc`, so their copies would fall behind and a late joiner there would be served stale state. Its server-to-server messages (`serverSideEmit`) are JSON, which turns a binary Yjs update into an array of numbers, so they are not used for updates. The server therefore publishes a binary frame (`kind`, sender id, document id, payload) on a Redis channel of its own, `<adapterKey>:relay`, and ignores frames that it sent itself. The adapter is still used for what it does well: cluster-wide room queries, which count a document's sockets across instances for the connection limit.

**Pub/sub is at-most-once**, so convergence does not depend on it. Every `COLLAB_RECONCILE_INTERVAL_MS` each loaded document reads the log past its cursor (and the newest snapshot, if a compaction by another instance has trimmed rows it never saw) and applies what it finds with the `remote` origin. Applying an update twice is a no-op in Yjs, so reading rows that the relay already delivered does nothing. A lost message therefore costs at most that interval, and the instances cannot diverge for longer.

**Costs.** Every instance receives the relay traffic of every document, whether or not it holds it, and discards what it does not hold. That is fine at the scale this project targets and is the first thing to change (a channel per document) if instances multiply.

## Limits

All are configuration, with the defaults below, and all have tests.

| Setting (environment variable)                              | Default                                                                   | What happens past it                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COLLAB_MAX_UPDATE_BYTES`                                   | 1 MiB                                                                     | The message is rejected (`too_large`) and the socket stays. A frame far beyond it closes the connection: the transport's buffer is this plus 1 KiB       |
| `COLLAB_MAX_MESSAGES_PER_SECOND` and `COLLAB_MESSAGE_BURST` | 100 per second, burst 200                                                 | The socket is disconnected. A token bucket per socket, checked before anything is queued                                                                 |
| `COLLAB_MAX_CONNECTIONS_PER_DOCUMENT`                       | 250                                                                       | The handshake is refused with `too_many_connections`. Counted across instances; a burst of simultaneous handshakes can overshoot by the number in flight |
| membership check                                            | on connect, on Redis message, every `COLLAB_MEMBERSHIP_RECHECK_MS` (60 s) | The user's sockets for the document are sent `revoked` and closed                                                                                        |

The rate limit disconnects instead of dropping because a dropped update would leave the client believing it was saved. A reconnect runs the handshake again and resends what the server lacks.

**Membership changes.** The web app publishes `{ documentId, userId, change }` on `collabdocs:membership` after it removes a member, changes a role or deletes a document. Every instance disconnects the matching sockets it holds. The client reconnects with a new token if it still has access; a removed user is refused at the handshake. Because pub/sub is at-most-once, each loaded document also compares its sockets with the `Membership` table every `COLLAB_MEMBERSHIP_RECHECK_MS`, so a lost message delays the disconnect by at most that interval, and the token's own five minutes are a second bound on reconnects.

## What happens when something fails

| Failure                                                | What happens                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The log append fails (database down, document deleted) | The instance drops the document from memory and disconnects its sockets. Nothing is relayed. Clients reconnect, reload from the database and send what it lacks                                                                                                                                     |
| The database is unreachable at connect                 | The handshake fails with `server_error`                                                                                                                                                                                                                                                             |
| Compaction fails                                       | Logged. The log keeps growing and the next trigger retries. Correctness is unaffected                                                                                                                                                                                                               |
| A stored update cannot be applied at load              | Logged and skipped; the rest of the document loads                                                                                                                                                                                                                                                  |
| Redis is down                                          | Relay and membership messages are lost (logged). Each instance serves its own sockets, other instances catch up by reading the log, and the periodic re-check catches membership changes. The connection-limit query needs Redis and fails the handshake with `server_error`; that path has no test |
| An instance crashes                                    | Its sockets drop and reconnect to another instance. Committed updates are in the log. Its presence entries expire on the others after 30 seconds                                                                                                                                                    |
| A client sends a malformed or oversized message        | Rejected and logged; the document and other clients are unaffected                                                                                                                                                                                                                                  |
| A viewer sends an update or a step 2                   | Rejected and logged with the user and role; the document is unchanged                                                                                                                                                                                                                               |
| A token expires while the socket is open               | The socket stays: the token is checked at the handshake only. Access is withdrawn by the membership checks above                                                                                                                                                                                    |

## Consequences

- The server is testable in process: tests start real servers on random ports and drive them with `yjs` and `socket.io-client`; nothing in the sync path is mocked.
- The web app and the collab server share the database tables, the secret and the Redis channel names, and nothing else.
- The log can be replayed or inspected with plain SQL.

## Alternatives rejected

- **`y-websocket`'s server and a persistence hook.** See 0001.
- **Appending from every instance that sees an update.** The rows would double, and the advisory lock would have to be replaced by a dedupe on content.
- **Persisting before applying.** It makes a write failure safe for the instance's state, but it needs a validity check of the update before it is stored; applying first and appending what the `Y.Doc` reports as new gives that check and the dedupe of no-op messages for free.
- **Compacting from the in-memory document.** It is wrong on several instances, whose copies may lag; the database is the one place that has everything.
- **One Redis channel per document.** Better fan-out, more subscription bookkeeping and a load race to reason about; deferred until the traffic of unwanted documents matters.
