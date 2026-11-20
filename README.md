# CollabDocs

A real-time collaborative document editor: Yjs over Socket.IO, live cursors and presence, and a role on every document that is checked on every route and every socket event.

## Status

Version 0.1 is in progress, task by task. Done so far (J-T1):

- an npm workspaces monorepo: `apps/web` (Next.js, App Router), `apps/collab` (empty until J-T2) and `packages/shared`;
- the PostgreSQL schema and migrations, with the ownership and membership rules enforced by the database;
- sign-in with GitHub OAuth and with email and password (Auth.js);
- the role model (`owner`, `editor`, `viewer`), `can(role, action)`, and the REST routes for documents and memberships, each checking the session and the role;
- the signed, short-lived collaboration token that the socket server will require;
- CI.

Not built yet: the collaboration server (J-T2), the editor UI (J-T3), the load tests (J-T4), the Lighthouse gate (J-T5). There is no editor to look at.

## Goals

The project is built to deliver four things. They are goals, **not yet measured**; each gets a test or a benchmark, and the numbers go here when they exist.

1. Yjs CRDT sync over Socket.IO with a latency under 100 ms. Defined as: with 50 editors on loopback, the p95 of the time from one client's write to every other client applying it.
2. 50 or more people editing one document at once, with live cursors and presence (the Yjs awareness protocol).
3. Every route and every WebSocket event protected, with OAuth and password sign-in and role-based permissions. The REST half is done and tested; the socket half is J-T2.
4. Lighthouse performance and accessibility of 92 or more, with Tailwind and Radix UI, enforced in CI.

## Layout

| Path              | What it is                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/web`        | Next.js app: pages, Auth.js, the REST API, the Prisma schema and migrations   |
| `apps/collab`     | The Socket.IO collaboration server (J-T2)                                     |
| `packages/shared` | Role rules (`can`), the collaboration token signer and verifier, shared types |
| `docs/design`     | Decision records                                                              |
| `scripts`         | `preflight.sh` and the hygiene check                                          |

The workspaces are managed with **npm workspaces**, not pnpm: the machine this was built on has neither pnpm nor corepack, and nothing here needs more than npm offers.

## Local setup

You need Node 22.12 or newer, PostgreSQL 15 or newer and Redis. On macOS with Homebrew:

```sh
brew install postgresql@17 redis      # skip what you have
brew services start postgresql@17
brew services start redis             # used by the collab server from J-T2

createdb collabdocs
createdb collabdocs_test              # the tests delete every row; the name must contain "test"

npm install
cp apps/web/.env.example apps/web/.env
```

Edit `apps/web/.env`: set `DATABASE_URL` (include your user name if PostgreSQL has no `postgres` role, for example `postgresql://you@localhost:5432/collabdocs`), and generate two different secrets with `openssl rand -base64 32` for `AUTH_SECRET` and `COLLAB_TOKEN_SECRET`. GitHub sign-in appears only when `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` are set; create an OAuth app with the callback URL `http://localhost:3000/api/auth/callback/github`. Password sign-in works without them.

```sh
npm run db:deploy                     # apply the migrations
npm run dev -w apps/web               # http://localhost:3000
```

Create a user and try the API:

```sh
curl -X POST localhost:3000/api/register -H 'content-type: application/json' \
  -d '{"email":"you@example.test","password":"a long passphrase"}'
```

Sign in at `http://localhost:3000/api/auth/signin`, then call the routes below with the session cookie.

## Tests and checks

```sh
export DATABASE_URL=postgresql://you@localhost:5432/collabdocs_test
npm run db:deploy
npm test                # unit and route tests; the route tests use PostgreSQL
npm run preflight       # everything CI runs
```

`scripts/preflight.sh` creates `collabdocs_test` if it is missing and uses it when `DATABASE_URL` is unset. A test that cannot reach PostgreSQL fails; it does not skip. CI runs the same steps with PostgreSQL and Redis as service containers.

## API

All bodies are JSON and must be sent with `Content-Type: application/json`. A caller who is not a member of a document gets `404`, the same answer as for a document that does not exist.

| Route                                        | Needs                  | Does                                    |
| -------------------------------------------- | ---------------------- | --------------------------------------- |
| `POST /api/register`                         | nothing                | create a password account               |
| `POST /api/documents`                        | a session              | create a document; the caller owns it   |
| `GET /api/documents`                         | a session              | the documents the caller is a member of |
| `GET /api/documents/:id`                     | `read`                 | one document and the caller's role      |
| `PATCH /api/documents/:id`                   | `write`                | rename                                  |
| `DELETE /api/documents/:id`                  | `delete`               | delete, with its memberships and data   |
| `GET /api/documents/:id/memberships`         | `read`                 | list members                            |
| `POST /api/documents/:id/memberships`        | `share`                | invite a registered user by email       |
| `PATCH /api/documents/:id/memberships/:uid`  | `change-role`          | change a member's role                  |
| `DELETE /api/documents/:id/memberships/:uid` | `change-role`, or self | remove a member, or leave               |
| `POST /api/documents/:id/collab-token`       | `read`                 | a signed token for the collab server    |

The role model and the token are described in [SECURITY.md](SECURITY.md) and [docs/design/0002-roles-and-tokens.md](docs/design/0002-roles-and-tokens.md).

## Things that will bite

- **Prisma 7 needs a driver adapter.** `lib/db.ts` builds the client with `@prisma/adapter-pg`, and the connection URL lives in `apps/web/prisma.config.ts`, not in `schema.prisma`. The client is created on first use so that `next build` needs no database.
- **Some invariants are in the migration SQL, not the schema.** A partial unique index and triggers enforce one owner per document and an append-only update log. Prisma does not see them, so `prisma migrate dev` will not generate them: edit the migration by hand, and CI's drift check (`npm run db:drift -w apps/web`) keeps the migrations and `schema.prisma` in step.
- **The credentials provider forces JWT sessions.** The Prisma adapter serves GitHub users and accounts only; the `Session` table exists for the adapter and stays empty.
- **`next-auth` is pinned to the 5.0 beta,** which is how Auth.js v5 is published. `next` is 16, `eslint` is pinned to `9.x` (`eslint-config-next` 16 is not ESLint 10 ready) and TypeScript to `5.9.x`.
- **`@node-rs/argon2` instead of `argon2`.** It ships prebuilt binaries, so `npm install` runs no native build, which failed on one machine.
- **`npm audit` reports three advisories** in `effect`, pulled in by the Prisma CLI (`prisma`, a dev dependency). Nothing reaches the runtime. Upgrade Prisma when a fixed release is out.

## Licence

MIT. See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
