# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-21

First release.

### Security

- **Presence identity.** The collab server now checks every awareness state a socket sets: it must carry `user.id` equal to the user in the socket's token, or the message is refused (`rejected`, `forbidden`) and nothing is relayed; a state with no `user` is refused too. The name shown for a user's cursor and presence entry is the display name in the token, which the web app writes from the session, and it replaces whatever name the client announced. Before, any member, a viewer included, could put a cursor or a presence entry under another member's name, or hide from the list.
- **Queued output and connections that join nothing.** Nothing bounded what the server queued for a connection, so a client that stopped reading could make it hold the whole document once per three-byte sync step 1, or hold Socket.IO's own replies to any number of CONNECT packets without ever authenticating. Now the server keeps a running count of the bytes and packets queued for each connection (Engine.IO's write buffer plus the WebSocket's buffered amount) and closes the connection, freeing the queue at once, when more than `COLLAB_MAX_OUTBOUND_BYTES` or `COLLAB_MAX_OUTBOUND_PACKETS` is queued. The count is read in constant time before a broadcast to a socket and before a reply to that socket's own message, and a sweep checks every connection every 500 ms, so connections that belong to no document and sockets on a quiet document are covered. Every connection's inbound packets are counted against a bucket (`COLLAB_MAX_PACKETS_PER_SECOND`, `COLLAB_PACKET_BURST`); a CONNECT for any namespace other than `/` closes the connection, and so does a refused handshake (once per connection, with the warning rate limited). The document sent in answer to a step 1 is charged to the socket's and the user's byte budgets, at most half of the burst each. At shutdown the documents are closed (queued updates written, the log compacted) while the sockets close, and a connection that is still open after a second is cut, so a client that does not read can no longer delay it.
- **Origin check.** `COLLAB_CORS_ORIGIN` is enforced on the WebSocket upgrade as well as on polling requests.
- **Unknown events.** An event with a name other than `sync` or `awareness` closes the socket; before, it was parsed and dropped outside every limit.

### Changed (behaviour that deployments may notice)

- **New limits:** `COLLAB_MAX_OUTBOUND_BYTES`, default 4 MiB (four times the default update size); `COLLAB_MAX_OUTBOUND_PACKETS`, default 16,384; `COLLAB_MAX_PACKETS_PER_SECOND` (250) and `COLLAB_PACKET_BURST` (500). A client that opens a document larger than the byte cap is disconnected at the first broadcast that reaches it while more than the cap of the reply is still queued, and reconnects; raise the limit for such documents.
- **Byte budgets also count what the server sends in reply** to a sync step 1, not only what a socket sends: the size of the document, at most half of the burst. A second tab or a quick reconnect on a document of a few MiB can be dropped until the user's budget refills (up to 8 seconds); see `docs/operations.md`.
- **A refused handshake closes the connection,** after the error has been sent.
- **A display name longer than 80 characters is cut without splitting an emoji.**
- **With `COLLAB_CORS_ORIGIN` unset, only a browser on the collab server's own origin may connect.** Set it to the web app's origin when the editor is served from another host or port (the README's local setup does). Clients that send no `Origin` header, such as the load generator, are not affected.
- **The collaboration token carries the user's display name** (`name`, at most 80 characters). The collab server refuses a token without it, so the web app and the collab server must be updated together; tokens live at most 15 minutes.
- **The editor announces no presence until it has set its user,** since the server refuses a state without one.

### Fixed (documentation)

- `.env.example` shows the real defaults (including the per-address handshake limit that it showed wrongly) and lists every variable the server reads; a test compares it with the code.
- The README says when an update reaches the other sockets (at once on the same instance; through Redis only after the commit), lists every API route, and links to the right section; SECURITY.md describes the CSRF rules and the member list as the code behaves; operations.md has the right start command, log stream and token wording.
- The README's performance numbers show the slowest delivery of every run, say which instrument measured the generator lag in which runs, and say that every editor typing was not measured above 100 editors.
- The fifteen load-test runs were repeated twice on release candidates, with the same protocol and default limits, and the README's numbers come from the last set, made on commit `127e75b` (every run valid and clean: nobody disconnected, rejected or refused, and the server logged no warning). The two earlier sets are kept, unchanged, in `apps/collab/bench/results/earlier-before-security-fixes` (commits `8d8cecd` and `2c1c3cb`, before the security fixes) and `apps/collab/bench/results/earlier-before-queue-sweep` (commit `f000b55`, before the per-connection queue limits).
- The hygiene check's deny-list no longer names any tool: it matches any co-author trailer, any line that credits a generator tool, and a vendor's no-reply address.

### Added (performance)

- **Sync-latency load test** (`apps/collab/bench`): headless editors speaking the real sync and awareness protocol against the real collab server, spread over several processes, with per-run JSON results committed under `apps/collab/bench/results`. The claim, the protocol and the rules for an invalid run are in `docs/benchmarks.md`, committed before the first measured run. The README's Performance section is filled from those files, and CI checks that every number in it appears in one of them.
- **Convergence property test** (fast-check, against a real server): random inserts, deletes and formatting from three clients, held back and released late, out of order and twice, with a disconnect and a reconnect, must end in the same state in every client and in the database, with no typed text lost.

### Changed: limits, Redis, roles and accounts

- **Collab server limits.** A per-socket byte budget, a cap on a document's stored size (writes are refused with `document_full`), a bounded queue of updates waiting for the database (the socket is closed with `overloaded`), and an 8 KiB cap on awareness messages.
- **Redis.** The server refuses to start, after a timeout, when Redis is configured and unreachable; during an outage open sockets keep working and new handshakes fail at once. The connection limit is counted atomically in Redis (the Socket.IO adapter is gone). Relay and membership messages carry an HMAC made with `REDIS_MESSAGE_SECRET`, which is now required with `REDIS_URL`.
- **Awareness** is bound to the user who announced it. **Roles** are read again when a socket attaches and, at most once per second, before a write; a periodic re-check that keeps failing closes the sockets.
- **Compaction** is retried after a failure and runs at close; content edits update `Document.updatedAt`; a document deleted mid-request answers 404.
- **Accounts.** Email verification with a pluggable mailer; invitations to an unverified address are held as pending and bind on verification; sign-in, registration and link requests are rate limited per client address and per account, with Redis counters and a per-process fallback.
- **Tests** for the database triggers, index and CHECK constraints, and for guards that nothing covered: relay after commit, the advisory locks, `REPEATABLE READ`, the body cap, the timing equaliser. The web tests drive the real Auth.js handlers for credentials sign-in and the GitHub-linking refusal.

### Changed: per-user limits, connection slots and accounts

- **Collab server.** A connection slot is released on every path, including a client that leaves during the handshake, and the heartbeat refreshes only sockets that are still connected, re-adds a slot that vanished and sends every document in one round. New per-user limits: sockets per user per document, a handshake rate limit per user and per address, one byte budget shared by a user's sockets, and a bound on payload bytes in flight. Updates whose dependencies are missing count against the document cap and the pending-bytes bound and are capped per document. A full document accepts updates that only delete. A write whose socket was revoked during its role check is dropped. Relay frames carry an issue time under the HMAC.
- **Accounts.** The sign-in limiter reads the email the way Auth.js does (JSON and form bodies; a repeated field or an ambiguous body is refused). Registration and invitations answer the same for every address, with the details sent by email, and the invite route is rate limited. An invitation binds only while its inviter may still share. An empty `TRUSTED_PROXY_HOPS` means the default; IPv6 clients count per /64. The web app refuses to start with Redis and no usable `REDIS_MESSAGE_SECRET`.
- **Tests** for the guards that survived mutation: the document cap at load, after a compaction and after a reconcile, a failing role query on the write path, the awareness state limit, a frozen Redis, the heartbeat, the purpose separation of the MACs and the single use of a verification link.

### Changed: address ceiling, accounts, editor alerts and CI

- **Collab server.** The per-address handshake limit is an anti-flood ceiling (2000 burst, 100 per second) counted only after the token verifies, so one anonymous client behind an unconfigured proxy cannot lock the others out; a warning is logged when `X-Forwarded-For` arrives and `COLLAB_TRUSTED_PROXY_HOPS` was never set. The in-memory limiters keep at most `COLLAB_RATE_LIMITER_MAX_KEYS` keys, evict the least recently used and count evictions at `/metrics`.
- **Accounts.** Registration does the same work for a new and an existing address. Invitations keep one row per inviter (a second inviter no longer takes over the first's), are limited per inviter and address with a mail cap per address, use a fixed mail subject and a flattened body, and answer an existing member with an id of the same format. The sign-in limiter matches the credentials route the way Auth.js resolves it, so no spelling of the URL skips it. `AUTH_URL` is required in production.
- **Editor.** A refused write (`document_full`, `too_large`, `forbidden`, `overloaded`, anything else) shows an alert saying what happened and what to do, and the indicator stops saying "Syncing".
- **CI.** The Lighthouse job fails when a report has a runtime error or when the editor page was scored without the `collabdocs:synced` mark.

### Added

- **Monorepo.** npm workspaces: `apps/web` (Next.js 16, App Router), `apps/collab` and `packages/shared`. TypeScript strict, ESLint 9, Prettier, Vitest; Playwright is installed for later tasks.
- **Database.** Prisma schema and a first migration: `User`, `Account`, `Session`, `VerificationToken`, `Document`, `Membership`, `DocumentSnapshot` and `DocumentUpdate`. One owner membership per document, an owner membership that matches `Document.ownerId`, one membership per user per document, an append-only update log and lower-case emails are enforced by the database.
- **Authentication.** Auth.js with GitHub OAuth and email plus password (argon2id), JWT sessions, a registration route.
- **Roles.** `can(role, action)` in `packages/shared` for the actions `read`, `write`, `share`, `delete` and `change-role`; REST routes to create, list, read, rename and delete documents and to invite, re-role and remove members, each checking the session and the role. A non-member gets 404.
- **Collaboration token.** `POST /api/documents/:id/collab-token` and a verifier in `packages/shared`: HS256, five minutes by default, bound to one document, one user and one role.
- **Collab server.** `apps/collab`: Yjs sync and awareness over Socket.IO, one room per document. The handshake verifies the collaboration token and the membership; every event is checked with `can`, so a viewer's update is rejected and logged. Updates are appended to the log and compacted into snapshots by count and by time; documents unload after a grace period. Several instances share documents through Redis (a binary relay channel) and persist each update once. Limits on update size, message rate and connections per document. Socket disconnect when a membership is removed or a role changes (the web app publishes the change). Design: `docs/design/0003-collab-server.md`.
- **CI.** Hygiene (no CJK text, no attribution lines, whole history), lint, typecheck, tests against PostgreSQL and Redis service containers, build, and `scripts/preflight.sh`.
- **Editor.** TipTap bound to a Yjs document, with a client provider for the collab server's contract: sync and awareness, a new token on every connection attempt, read-only mode for viewers (nothing is sent), remote cursors and selections with name and colour, a presence list, a connection indicator, edits kept in IndexedDB and merged on reconnect. Pages for sign-in, registration, the document list (mine and shared with me), create and rename, and a share dialog (invite, change role, remove) built on Radix UI and Tailwind. Design: `docs/design/0004-editor-client.md`.
- **End-to-end tests.** Playwright with two or three browser contexts against the built web app and a real collab server: concurrent typing, a read-only viewer, remote cursors, an offline merge, edits kept across a reload, removal and demotion of a member, and the pages. A CI job runs them with PostgreSQL and Redis; `scripts/preflight.sh` runs them too.
