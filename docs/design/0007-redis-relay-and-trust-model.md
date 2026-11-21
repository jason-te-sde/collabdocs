# 0007. The Redis relay and its trust model

Status: accepted. Supersedes the Socket.IO Redis adapter that [0001](0001-monorepo-and-socket-io.md) counted on. Details in [0003](0003-collab-server.md); the threat view is in [SECURITY.md](../../SECURITY.md).

## Context

With more than one collab instance, a client connected to instance A must see the edits and cursors of a client connected to instance B. The web app must also be able to tell every instance that a member was removed or a role changed. Redis is the shared channel for both. Redis is also a place where anyone who reaches the network, or the server, can publish.

## Decision

- **A relay channel of our own**, `<adapterKey>:relay`, carries binary frames (kind, sender id, document id, user id for awareness, payload). The instance that receives an update appends it to the log first and publishes it only after the append commits; the others apply it with a `remote` transaction origin that is never appended. Awareness frames take the same path without the append. An instance ignores its own frames.
- **Pub/sub is at-most-once, so correctness never depends on it.** Every few seconds each loaded document reads the log past its cursor and applies what it finds; applying an update twice is a no-op in Yjs. Membership changes are repaired by a periodic comparison of sockets with the `Membership` table.
- **Redis is trusted for availability and secrecy, not for integrity.** Every relay frame and membership message carries an HMAC-SHA256 under `REDIS_MESSAGE_SECRET`, bound to the channel's purpose. A message without a valid tag is logged and ignored. A membership message carries its issue time and is ignored after two minutes. The collab server and the web app refuse to start with `REDIS_URL` and no usable secret (at least 32 bytes, different from the other secrets).
- **Connection counting is atomic in Redis** (a Lua script on a sorted set with expiry scores from Redis's clock), because a check followed by an add would let simultaneous handshakes all pass.

## Consequences

- Someone with Redis access but not the secret cannot inject an update, forge a role change or disconnect a user. They can still read document content and presence from the channel (updates are not encrypted), drop, delay or replay messages (repaired by the log reads and the re-checks, and bounded by the two-minute window), and write the connection counters, which can refuse new sockets until the entries expire. Redis therefore belongs on a private network, with a password and TLS where it is shared, and the secret is as sensitive as `COLLAB_TOKEN_SECRET`.
- A Redis outage stops relay, membership messages and new handshakes (refused with `server_error` without waiting); open sockets keep editing and storing. Other instances catch up from the log when Redis returns.
- Every instance receives the relay traffic of every document and discards what it does not hold. Fine at this scale; a channel per document is the first change if instances multiply.
- Clocks on the servers must agree within about 30 seconds for the replay window to work.

## Alternatives rejected

- **The Socket.IO Redis adapter.** It delivers a broadcast to the sockets of other instances but does not put the update into their `Y.Doc`, so their copies fall behind; its server-to-server messages are JSON, which turns a binary update into an array of numbers; and its requests wait for seconds when Redis is down, which the handshake must not. It also gives no integrity.
- **Trusting the network.** A Redis that any host on the network can publish to would let one host inject content into any document.
- **Encrypting the relay.** It would hide document content from Redis readers, at the cost of key distribution and a decrypt on every instance for every document it does not hold. Left out; the mitigation is network isolation.
- **A Redis channel per document.** Better fan-out, but subscription bookkeeping and a load race to reason about. Deferred.
- **Relaying through the database (`LISTEN`/`NOTIFY`).** Possible, but the payload limit is small and it would load the database that every write already uses.
