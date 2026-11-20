# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (review round)

- **Collab server limits.** A per-socket byte budget, a cap on a document's stored size (writes are refused with `document_full`), a bounded queue of updates waiting for the database (the socket is closed with `overloaded`), and an 8 KiB cap on awareness messages.
- **Redis.** The server refuses to start, after a timeout, when Redis is configured and unreachable; during an outage open sockets keep working and new handshakes fail at once. The connection limit is counted atomically in Redis (the Socket.IO adapter is gone). Relay and membership messages carry an HMAC made with `REDIS_MESSAGE_SECRET`, which is now required with `REDIS_URL`.
- **Awareness** is bound to the user who announced it. **Roles** are read again when a socket attaches and, at most once per second, before a write; a periodic re-check that keeps failing closes the sockets.
- **Compaction** is retried after a failure and runs at close; content edits update `Document.updatedAt`; a document deleted mid-request answers 404.
- **Accounts.** Email verification with a pluggable mailer; invitations to an unverified address are held as pending and bind on verification; sign-in, registration and link requests are rate limited per client address and per account, with Redis counters and a per-process fallback.
- **Tests** for the database triggers, index and CHECK constraints, and for guards that nothing covered: relay after commit, the advisory locks, `REPEATABLE READ`, the body cap, the timing equaliser. The web tests drive the real Auth.js handlers for credentials sign-in and the GitHub-linking refusal.

### Added

- **Monorepo.** npm workspaces: `apps/web` (Next.js 16, App Router), `apps/collab` and `packages/shared`. TypeScript strict, ESLint 9, Prettier, Vitest; Playwright is installed for later tasks.
- **Database.** Prisma schema and a first migration: `User`, `Account`, `Session`, `VerificationToken`, `Document`, `Membership`, `DocumentSnapshot` and `DocumentUpdate`. One owner membership per document, an owner membership that matches `Document.ownerId`, one membership per user per document, an append-only update log and lower-case emails are enforced by the database.
- **Authentication.** Auth.js with GitHub OAuth and email plus password (argon2id), JWT sessions, a registration route.
- **Roles.** `can(role, action)` in `packages/shared` for the actions `read`, `write`, `share`, `delete` and `change-role`; REST routes to create, list, read, rename and delete documents and to invite, re-role and remove members, each checking the session and the role. A non-member gets 404.
- **Collaboration token.** `POST /api/documents/:id/collab-token` and a verifier in `packages/shared`: HS256, five minutes by default, bound to one document, one user and one role.
- **Collab server.** `apps/collab`: Yjs sync and awareness over Socket.IO, one room per document. The handshake verifies the collaboration token and the membership; every event is checked with `can`, so a viewer's update is rejected and logged. Updates are appended to the log and compacted into snapshots by count and by time; documents unload after a grace period. Several instances share documents through Redis (a binary relay channel plus the Socket.IO adapter) and persist each update once. Limits on update size, message rate and connections per document. Socket disconnect when a membership is removed or a role changes (the web app publishes the change). Design: `docs/design/0003-collab-server.md`.
- **CI.** Hygiene (no CJK text, no attribution lines, whole history), lint, typecheck, tests against PostgreSQL and Redis service containers, build, and `scripts/preflight.sh`.
- **Editor.** TipTap bound to a Yjs document, with a client provider for the collab server's contract: sync and awareness, a new token on every connection attempt, read-only mode for viewers (nothing is sent), remote cursors and selections with name and colour, a presence list, a connection indicator, edits kept in IndexedDB and merged on reconnect. Pages for sign-in, registration, the document list (mine and shared with me), create and rename, and a share dialog (invite, change role, remove) built on Radix UI and Tailwind. Design: `docs/design/0004-editor-client.md`.
- **End-to-end tests.** Playwright with two or three browser contexts against the built web app and a real collab server: concurrent typing, a read-only viewer, remote cursors, an offline merge, edits kept across a reload, removal and demotion of a member, and the pages. A CI job runs them with PostgreSQL and Redis; `scripts/preflight.sh` runs them too.
