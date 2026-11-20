# 0005. y-protocols over Socket.IO, not y-websocket

Status: accepted. Refines [0001](0001-monorepo-and-socket-io.md); the server is described in [0003](0003-collab-server.md).

## Context

The editor binds TipTap to a Yjs document. Two things must travel between browsers and the server: document updates (the sync protocol) and cursors and presence (the awareness protocol). `y-websocket` is the reference provider and server for both, and the obvious choice. This project has three requirements it does not meet as shipped: a role checked on every event (a viewer's write must be refused, not merely not sent), a connection handshake that verifies a signed token and a database membership before any document is loaded, and per-socket, per-user and per-document limits that close a misbehaving socket.

## Decision

- Use the `y-protocols` sync and awareness encoders and decoders directly, and carry the messages as binary payloads in two Socket.IO events, `sync` and `awareness`. The event name says what the message is, so the outer message-type byte of `y-websocket` is dropped.
- Write the server (`apps/collab`) and the client provider (`apps/web/lib/collab/provider.ts`) ourselves. The provider is a small class around a `Y.Doc` and an `Awareness`; the server holds one `Y.Doc` per open document.
- Authenticate in the Socket.IO handshake (`auth: { token, documentId }`), then decide per event with `can(role, action)`: `read` for sync step 1 and awareness, `write` for sync step 2 and updates.

## Consequences

- The server sees every message before it touches a document, so role checks, size limits, rate limits and the awareness ownership rule are ordinary code at one choke point, with tests that drive real sockets.
- Socket.IO adds reconnection hooks, rooms, acknowledgements and a binary framing of its own. The cost is an extra layer of framing and a heavier client bundle than a bare WebSocket; the sync-latency benchmark (a later task) measures what it costs.
- The client is WebSocket only: long polling would need sticky sessions behind a load balancer, which this design does not assume.
- We own the provider's reconnection, offline merge and state machine, and must test them ourselves (they are: unit tests and Playwright tests with a real network cut).
- A step 2 message carries content, so it is a write. A viewer is never sent a step 1, so an honest viewer never has to answer with a step 2.

## Alternatives rejected

- **`y-websocket` server with an auth callback.** It authenticates the upgrade request but has no per-message hook for roles, and its limits and persistence hooks would have to be forked around. A server that cannot refuse a single message from a viewer does not meet the requirement.
- **`y-webrtc` or other peer-to-peer providers.** There is no server to enforce roles or persist; a peer cannot be trusted to refuse another peer's write.
- **A hosted provider (Liveblocks, Hocuspocus Cloud).** Moves the permission model and the data out of the project, and the project exists to show that model.
- **Hocuspocus (self-hosted).** The closest alternative: it has authentication and per-document hooks. It would still leave the per-message checks, the Redis relay and the limits to be written against its internals, for the price of a dependency on a framework whose behaviour the tests would have to pin.
