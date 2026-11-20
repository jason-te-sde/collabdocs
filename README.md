# CollabDocs

A real-time collaborative document editor: Yjs over Socket.IO, live cursors and presence, and a role on every document that is checked on every route and every socket event.

## Status

Version 0.1 is nearly complete. Built:

- an npm workspaces monorepo: `apps/web` (Next.js, App Router), `apps/collab` (the collab server) and `packages/shared`;
- the PostgreSQL schema and migrations, with the ownership and membership rules enforced by the database;
- sign-in with GitHub OAuth and with email and password (Auth.js), email verification, rate limits;
- the role model (`owner`, `editor`, `viewer`), `can(role, action)`, and the REST routes for documents and memberships, each checking the session and the role;
- the signed, short-lived collaboration token that the socket server requires;
- the collab server: Yjs sync and awareness over Socket.IO, a role check on every event, persistence (an update log compacted into snapshots), several instances behind Redis, and configurable limits;
- the editor: TipTap bound to a Yjs document, remote cursors and a presence list, a connection indicator, read-only mode for viewers, edits kept in IndexedDB and merged on reconnect, pages for sign-in, the document list and sharing (Tailwind and Radix UI);
- Playwright end-to-end tests with two or three real browsers, and an axe-core accessibility check on the pages;
- CI, including a Lighthouse gate (performance and accessibility of at least 0.92).

Not done yet: the sync-latency load test ([Performance](#performance)) and the public release.

## The editor

![Ada's browser, with Grace's selection and Linus's cursor shown live, each with a name, and the presence list naming all three](docs/images/editor-two-cursors.png)

The screenshot is Ada's browser, one of three Playwright browsers in the same document. Grace has a word selected and Linus has his cursor at the end of the last line; both appear live, in their own colour, with their name, and the presence list above the text names everyone in the document. The screenshots are regenerated with `SCREENSHOTS=1 npm run test:e2e -- screenshots`.

| Sharing                                                                                                        | Offline                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ![The share dialog: invite by email with a role, change a role, remove a member](docs/images/share-dialog.png) | ![Grace is offline: the status line says her edits are saved on this device and will sync when she is back](docs/images/offline.png) |

- **Roles in the page.** A viewer's editor is not editable, has no toolbar and sends nothing to the server (the server would refuse it anyway). An editor can invite people; only the owner can change roles or remove members. A role change takes effect in the open page: the server closes the socket, the client asks for a new token and reconnects with the new role.
- **Offline.** The browser going offline closes the socket at once. Edits stay in the local Y.Doc and in IndexedDB (one database per user and document, deleted when the server says the user has no access any more), so they survive a reload too. When the connection returns, the sync handshake sends them and both sides converge; nothing is overwritten, because Yjs merges per character.
- **Connection states.** Connecting, connected, syncing, reconnecting, offline (with a note when there are unsynced edits) and no access. The indicator is a polite live region.
- **Reconnecting** is done by the client, with a fresh collaboration token on every attempt and exponential backoff with jitter (see [0004](docs/design/0004-editor-client.md)).

## Goals

The project is built to deliver four things. Goals 1 and 2 are **not yet measured**: each gets a benchmark, and the numbers go in [Performance](#performance) when they exist. Goals 3 and 4 have tests that run in CI.

1. Yjs CRDT sync over Socket.IO with a latency under 100 ms. Defined as: with 50 editors on loopback, the p95 of the time from one client's write to every other client applying it.
2. 50 or more people editing one document at once, with live cursors and presence (the Yjs awareness protocol).
3. Every route and every WebSocket event protected, with OAuth and password sign-in and role-based permissions. Both halves are done and tested: the REST routes and the socket server.
4. Lighthouse performance and accessibility of 92 or more, with Tailwind and Radix UI, enforced in CI. Done: see [Lighthouse](#lighthouse).

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI["TipTap editor + Yjs doc<br/>(IndexedDB copy)"]
  end
  subgraph Web["apps/web (Next.js)"]
    Pages["Pages, Auth.js sessions"]
    API["REST API: documents, memberships,<br/>collab-token"]
  end
  subgraph Collab["apps/collab (Socket.IO), one or more instances"]
    Sock["Handshake: token + membership<br/>Every event: can(role, action)"]
    Mem["Y.Doc per open document"]
  end
  PG[("PostgreSQL<br/>users, documents, memberships,<br/>update log, snapshots")]
  RD[("Redis<br/>signed relay, membership messages,<br/>connection counters, rate limits")]

  UI -- "HTTPS: pages, REST" --> Pages
  UI -- "HTTPS" --> API
  UI == "WebSocket: sync + awareness<br/>(y-protocols)" ==> Sock
  API -- "signed 5-minute token" --> UI
  API --> PG
  API -- "membership changes (HMAC)" --> RD
  Sock --> Mem
  Mem -- "append update, compact into snapshot" --> PG
  Sock -- "membership lookup" --> PG
  Mem <-- "relay frames (HMAC)" --> RD
```

The browser gets a page and a collaboration token from the web app, then opens one Socket.IO connection per document to the collab server. The server checks the token and the membership in the database when the socket connects, and the role again on every message. An accepted update is applied to the server's copy of the document, appended to the update log in PostgreSQL, and only then relayed to the other sockets and, through Redis, to the other collab instances. Why each piece is the way it is: [docs/design](docs/design) (0001 monorepo and Socket.IO, 0002 roles and tokens, 0003 the collab server, 0004 the editor client, 0005 y-protocols over Socket.IO, 0006 the update log and snapshots, 0007 the Redis relay and its trust model).

## Layout

| Path              | What it is                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/web`        | Next.js app: pages, Auth.js, the REST API, the Prisma schema and migrations   |
| `apps/collab`     | The Socket.IO collaboration server                                            |
| `packages/shared` | Role rules (`can`), the collaboration token signer and verifier, shared types |
| `docs/design`     | Decision records                                                              |
| `docs/images`     | README screenshots, produced by the e2e tests                                 |
| `scripts`         | `preflight.sh` and the hygiene check                                          |

The workspaces are managed with **npm workspaces**, not pnpm: the machine this was built on has neither pnpm nor corepack, and nothing here needs more than npm offers.

## Run it locally

You need Node 22.12 or newer and either Docker or your own PostgreSQL 15+ and Redis.

```sh
docker compose up -d                  # PostgreSQL 17 and Redis 7; creates collabdocs and collabdocs_test
npm install
cp apps/web/.env.example apps/web/.env
```

Without Docker, on macOS with Homebrew: `brew install postgresql@17 redis`, start both with `brew services start`, then `createdb collabdocs` and `createdb collabdocs_test` (the tests delete every row; the name must contain "test").

Edit `apps/web/.env`:

- `DATABASE_URL`: `postgresql://collabdocs:collabdocs@localhost:5432/collabdocs` with the compose file (the credentials are for a database on your own machine);
- `REDIS_URL`: `redis://localhost:6379`;
- `AUTH_SECRET`, `COLLAB_TOKEN_SECRET` and `REDIS_MESSAGE_SECRET`: three different values, each from `openssl rand -base64 32`. `REDIS_MESSAGE_SECRET` is required whenever `REDIS_URL` is set; the apps refuse to start without it.

GitHub sign-in appears only when `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` are set; create an OAuth app with the callback URL `http://localhost:3000/api/auth/callback/github`. Password sign-in works without them. In development the verification mail is printed in the terminal that runs the web app (`MAIL_TRANSPORT=console`, the default outside production); see [SECURITY.md](SECURITY.md) for plugging in a real mail provider. Every variable is described in [docs/operations.md](docs/operations.md).

```sh
npm run db:deploy                     # apply the migrations
npm run dev -w apps/web               # http://localhost:3000
```

The editor also needs the collab server (next section). The page tells the browser where it is from `COLLAB_URL` (default `http://localhost:4000`), which is read when the page is rendered, so one build serves any deployment.

Create a user and try the API:

```sh
curl -X POST localhost:3000/api/register -H 'content-type: application/json' \
  -d '{"email":"you@example.test","password":"a long passphrase"}'
```

Sign in at `http://localhost:3000/api/auth/signin`, then call the routes below with the session cookie.

## Running the collab server

```sh
export DATABASE_URL=postgresql://collabdocs:collabdocs@localhost:5432/collabdocs
export REDIS_URL=redis://localhost:6379          # optional: without it the server runs alone
export COLLAB_TOKEN_SECRET=...                   # the same value the web app uses
export REDIS_MESSAGE_SECRET=...                  # required with REDIS_URL; the same value the web app uses
npm run start -w apps/collab                     # listens on :4000, GET /healthz
```

The web app asks for a token (`POST /api/documents/:id/collab-token`) and the client connects with `io("http://localhost:4000", { auth: { token, documentId } })`, then speaks the y-protocols sync and awareness messages in the `sync` and `awareness` events (see [0003](docs/design/0003-collab-server.md)). To run two instances behind Redis, start a second one with another `COLLAB_PORT`; they share documents through Redis and the database, and put a load balancer in front.

## Limits

Everything the collab server limits is an environment variable; the defaults are in the table, and [docs/operations.md](docs/operations.md) says what happens past each one and when to change it. Every limit has a test. The web app's account limits (sign-in, registration, invitations) are in [SECURITY.md](SECURITY.md).

| Variable                                | Default   | Meaning                                                          |
| --------------------------------------- | --------- | ---------------------------------------------------------------- |
| `COLLAB_PORT`, `COLLAB_HOST`            | 4000, all | where it listens                                                 |
| `COLLAB_CORS_ORIGIN`                    | none      | allowed browser origins, comma separated                         |
| `COLLAB_MAX_UPDATE_BYTES`               | 1048576   | largest sync message                                             |
| `COLLAB_MAX_AWARENESS_BYTES`            | 8192      | largest awareness message                                        |
| `COLLAB_MAX_MESSAGES_PER_SECOND`        | 100       | per socket; over it the socket is disconnected                   |
| `COLLAB_MESSAGE_BURST`                  | 200       | messages a socket may send at once                               |
| `COLLAB_MAX_BYTES_PER_SECOND`           | 262144    | per socket; over it the socket is disconnected                   |
| `COLLAB_BYTE_BURST`                     | 2097152   | bytes a socket may send at once (at least the update maximum)    |
| `COLLAB_MAX_DOCUMENT_BYTES`             | 16777216  | snapshot plus log; past it writes are refused                    |
| `COLLAB_MAX_PENDING_BYTES`              | 8388608   | accepted but not yet stored, per document; past it, disconnect   |
| `COLLAB_MAX_CONNECTIONS_PER_DOCUMENT`   | 250       | across instances                                                 |
| `COLLAB_MAX_CONNECTIONS_PER_USER`       | 8         | sockets one user may hold on one document, across instances      |
| `COLLAB_HANDSHAKE_BURST_PER_USER`       | 20        | handshakes a user may start at once, per instance                |
| `COLLAB_HANDSHAKES_PER_SECOND_PER_USER` | 1         | then this many per second; over it, `rate_limited`               |
| `COLLAB_HANDSHAKE_BURST_PER_IP`         | 100       | the same per client address (IPv6: per /64), per instance        |
| `COLLAB_HANDSHAKES_PER_SECOND_PER_IP`   | 5         |                                                                  |
| `COLLAB_MAX_BYTES_PER_SECOND_PER_USER`  | 524288    | shared by all of a user's sockets, per instance                  |
| `COLLAB_BYTE_BURST_PER_USER`            | 4194304   | at least the update maximum                                      |
| `COLLAB_MAX_IN_FLIGHT_BYTES`            | 67108864  | received but not yet processed, all sockets of the instance      |
| `COLLAB_MAX_PENDING_STRUCT_BYTES`       | 1048576   | updates waiting for a missing dependency, per document           |
| `COLLAB_TRUSTED_PROXY_HOPS`             | 0         | proxies in front that append to `X-Forwarded-For` (0 ignores it) |
| `REDIS_MESSAGE_SECRET`                  | none      | required with `REDIS_URL`; signs the Redis messages              |
| `COLLAB_REDIS_CONNECT_TIMEOUT_MS`       | 5000      | start fails if Redis is not reachable within this                |
| `COLLAB_CONNECTION_TTL_MS`              | 45000     | a dead instance's connection slots expire after this             |
| `COLLAB_COMPACT_EVERY_UPDATES`          | 200       | compact the log into a snapshot after this many updates          |
| `COLLAB_COMPACT_AFTER_MS`               | 30000     | or this long after the first uncompacted update                  |
| `COLLAB_UNLOAD_GRACE_MS`                | 30000     | keep a document in memory this long after its last client left   |
| `COLLAB_RECONCILE_INTERVAL_MS`          | 5000      | how often an instance reads the log for updates it did not see   |
| `COLLAB_MEMBERSHIP_RECHECK_MS`          | 60000     | how often sockets are checked against the `Membership` table     |
| `COLLAB_ROLE_CACHE_MS`                  | 1000      | a socket's role is read again before a write if older than this  |

## Security model

Every REST route checks the session and the role; the collab server verifies a signed 5-minute token and the database membership when a socket connects, and `can(role, action)` on every event after that, so a viewer cannot write and a removed member stops writing within about a second. A caller who is not a member of a document gets the same 404 as for a document that does not exist. Passwords are hashed with argon2id, sign-in and registration are rate limited, invitations and registration answer the same for every address, and messages on Redis are signed so that access to Redis alone cannot inject an update or disconnect a user. What is left, by design, is listed in the "Known limits" section. The full model: [SECURITY.md](SECURITY.md).

## Tests and checks

```sh
export DATABASE_URL=postgresql://you@localhost:5432/collabdocs_test
npm run db:deploy
npm test                # unit, route and collab server tests; they use PostgreSQL and Redis
npm run preflight       # everything CI runs
```

`scripts/preflight.sh` creates `collabdocs_test` if it is missing and uses it when `DATABASE_URL` is unset; `REDIS_URL` defaults to `redis://localhost:6379`. Set `REDIS_URL` before `npm test`. A test that cannot reach PostgreSQL or Redis fails; it does not skip. The collab server tests start real servers in process on random ports and use their own Redis channel names. CI runs the same steps with PostgreSQL and Redis as service containers.

## End-to-end tests

```sh
npx playwright install chromium       # once; or set PW_CHANNEL=chrome to use an installed Chrome
export DATABASE_URL=postgresql://you@localhost:5432/collabdocs_test
npm run build -w apps/web
npm run test:e2e                      # starts the web app on :3100 and a collab server on :4100
```

The tests drive two or three browser contexts at once (owner, editor, viewer) against the built app and a real collab server, with PostgreSQL and Redis running:

- two people type at the same time and both end with the same text containing both inputs;
- a viewer sees the edits live, cannot type, and sends nothing;
- remote cursors, selections and the presence list;
- one context goes offline (`context.setOffline(true)`), both keep typing, it returns, and each side's characters are all there, in order, with none added;
- edits made while the server is unreachable survive a reload and sync afterwards;
- a removed member is disconnected and loses the page and the local copy; a demoted editor becomes read-only without a reload;
- registration, sign-in, creating, renaming and sharing through the pages;
- axe-core (`@axe-core/playwright`) on the sign-in page, the document list, the editor with another person's cursor in it, and the open share dialog: any serious or critical violation fails the test.

The README's screenshots are produced by `SCREENSHOTS=1 npm run test:e2e -- screenshots`.

## API

All bodies are JSON and must be sent with `Content-Type: application/json`. A caller who is not a member of a document gets `404`, the same answer as for a document that does not exist.

| Route                                        | Needs                  | Does                                                        |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `POST /api/register`                         | nothing                | create a password account (same answer for a taken address) |
| `POST /api/documents`                        | a session              | create a document; the caller owns it                       |
| `GET /api/documents`                         | a session              | the documents the caller is a member of                     |
| `GET /api/documents/:id`                     | `read`                 | one document and the caller's role                          |
| `PATCH /api/documents/:id`                   | `write`                | rename                                                      |
| `DELETE /api/documents/:id`                  | `delete`               | delete, with its memberships and data                       |
| `GET /api/documents/:id/memberships`         | `read`                 | list members                                                |
| `POST /api/documents/:id/memberships`        | `share`                | invite an address by email (always 202)                     |
| `PATCH /api/documents/:id/memberships/:uid`  | `change-role`          | change a member's role                                      |
| `DELETE /api/documents/:id/memberships/:uid` | `change-role`, or self | remove a member, or leave                                   |
| `POST /api/documents/:id/collab-token`       | `read`                 | a signed token for the collab server                        |

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
