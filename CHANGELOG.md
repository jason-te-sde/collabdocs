# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Monorepo.** npm workspaces: `apps/web` (Next.js 16, App Router), `apps/collab` and `packages/shared`. TypeScript strict, ESLint 9, Prettier, Vitest; Playwright is installed for later tasks.
- **Database.** Prisma schema and a first migration: `User`, `Account`, `Session`, `VerificationToken`, `Document`, `Membership`, `DocumentSnapshot` and `DocumentUpdate`. One owner membership per document, an owner membership that matches `Document.ownerId`, one membership per user per document, an append-only update log and lower-case emails are enforced by the database.
- **Authentication.** Auth.js with GitHub OAuth and email plus password (argon2id), JWT sessions, a registration route.
- **Roles.** `can(role, action)` in `packages/shared` for the actions `read`, `write`, `share`, `delete` and `change-role`; REST routes to create, list, read, rename and delete documents and to invite, re-role and remove members, each checking the session and the role. A non-member gets 404.
- **Collaboration token.** `POST /api/documents/:id/collab-token` and a verifier in `packages/shared`: HS256, five minutes by default, bound to one document, one user and one role.
- **Collab server.** `apps/collab`: Yjs sync and awareness over Socket.IO, one room per document. The handshake verifies the collaboration token and the membership; every event is checked with `can`, so a viewer's update is rejected and logged. Updates are appended to the log and compacted into snapshots by count and by time; documents unload after a grace period. Several instances share documents through Redis (a binary relay channel plus the Socket.IO adapter) and persist each update once. Limits on update size, message rate and connections per document. Socket disconnect when a membership is removed or a role changes (the web app publishes the change). Design: `docs/design/0003-collab-server.md`.
- **CI.** Hygiene (no CJK text, no attribution lines, whole history), lint, typecheck, tests against PostgreSQL and Redis service containers, build, and `scripts/preflight.sh`.
