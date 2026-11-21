# CollabDocs

A real-time collaborative document editor: Yjs over Socket.IO, live cursors and presence, and a role on every document that is checked on every route and every socket event.

## Status

Version 0.1.0 is the first release ([CHANGELOG](CHANGELOG.md)). It contains:

- an npm workspaces monorepo: `apps/web` (Next.js, App Router), `apps/collab` (the collab server) and `packages/shared`;
- the PostgreSQL schema and migrations, with the ownership and membership rules enforced by the database;
- sign-in with GitHub OAuth and with email and password (Auth.js), email verification, rate limits;
- the role model (`owner`, `editor`, `viewer`), `can(role, action)`, and the REST routes for documents and memberships, each checking the session and the role;
- the signed, short-lived collaboration token that the socket server requires;
- the collab server: Yjs sync and awareness over Socket.IO, a role check on every event, persistence (an update log compacted into snapshots), several instances behind Redis, and configurable limits;
- the editor: TipTap bound to a Yjs document, remote cursors and a presence list, a connection indicator, read-only mode for viewers, edits kept in IndexedDB and merged on reconnect, pages for sign-in, the document list and sharing (Tailwind and Radix UI);
- Playwright end-to-end tests with two or three real browsers, and an axe-core accessibility check on the pages;
- a property test that random concurrent edits, delivered late, out of order and across a disconnect, always converge (against a real server);
- the sync-latency load test, with its protocol written down before the first run and its results committed ([Performance](#performance));
- CI, including a Lighthouse gate (performance and accessibility of at least 0.92) and a check that every number in the Performance section is in a committed results file.

What it leaves out, on purpose, is listed under "Known limits" in [SECURITY.md](SECURITY.md) (no password reset, no rate limit on the document routes; that ownership cannot be transferred is under "What you may do") and under "Not measured" in [Performance](#performance).

## The editor

![Ada's browser, with Grace's selection and Linus's cursor shown live, each with a name, and the presence list naming all three](docs/images/editor-two-cursors.png)

The screenshot is Ada's browser, one of three Playwright browsers in the same document. Grace has a word selected and Linus has his cursor at the end of the last line; both appear live, in their own colour, with their name, and the presence list above the text names everyone in the document. To produce them again, run `SCREENSHOTS=1 npm run test:e2e -- screenshots`.

| Sharing                                                                                                        | Offline                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ![The share dialog: invite by email with a role, change a role, remove a member](docs/images/share-dialog.png) | ![Grace is offline: the status line says her edits are saved on this device and will sync when she is back](docs/images/offline.png) |

- **Roles in the page.** A viewer's editor is not editable, has no toolbar and sends nothing to the server (the server would refuse it anyway). An editor can invite people; only the owner can change roles or remove members. A role change takes effect in the open page: the server closes the socket, the client asks for a new token and reconnects with the new role.
- **Offline.** The browser going offline closes the socket at once. Edits stay in the local Y.Doc and in IndexedDB (one database per user and document, deleted when the server says the user has no access any more), so they survive a reload too. When the connection returns, the sync handshake sends them and both sides converge; nothing is overwritten, because Yjs merges per character.
- **Connection states.** Connecting, connected, syncing, reconnecting, offline (with a note when there are unsynced edits) and no access. The indicator is a polite live region.
- **Reconnecting** is done by the client, with a fresh collaboration token on every attempt and exponential backoff with jitter (see [0004](docs/design/0004-editor-client.md)).

## Goals

The project is built to deliver four things. Goals 1 and 2 are measured by the load test, and the numbers, with how many editors typed in each run and what they do and do not show, are in [Performance](#performance). Goals 3 and 4 have tests that run in CI.

1. Yjs CRDT sync over Socket.IO with a latency under 100 ms. Defined as: with 50 editors on loopback, the p95, over every (edit, receiving editor) pair, of the time from one client's write to each other client applying it.
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

The browser gets a page and a collaboration token from the web app, then opens one Socket.IO connection per document to the collab server. The server checks the token and the membership in the database when the socket connects, and the role again on every message. An accepted update is applied to the server's copy of the document and sent at once to the other sockets on that instance; it is appended to the update log in PostgreSQL right after, and only once that commit has succeeded is it relayed, through Redis, to the other collab instances. Why each piece is the way it is: [docs/design](docs/design) (0001 monorepo and Socket.IO, 0002 roles and tokens, 0003 the collab server, 0004 the editor client, 0005 y-protocols over Socket.IO, 0006 the update log and snapshots, 0007 the Redis relay and its trust model).

## Lighthouse

CI fails when performance or accessibility is below 0.92 on any of three pages, for the desktop preset and for the mobile emulation, on the median of three reports. The table below is built by [`scripts/lighthouse/readme-table.mjs`](scripts/lighthouse/readme-table.mjs) from the `lighthouse-reports` artifacts of several CI runs, so that it shows the spread and not one run.

<!-- prettier-ignore-start -->
<!-- lighthouse-table:start -->

Each cell is **min / median / max** of the per-run medians across 3 runs of the same commit's `lighthouse` job: [44801088199 attempt 1](https://github.com/jason-te-sde/collabdocs/actions/runs/44801088199/attempts/1), [44801088199 attempt 2](https://github.com/jason-te-sde/collabdocs/actions/runs/44801088199/attempts/2), [44801088199 attempt 3](https://github.com/jason-te-sde/collabdocs/actions/runs/44801088199/attempts/3). Every per-run median is the median of three Lighthouse reports, the number the gate checks. Lighthouse 13.6.0, presets `desktop` and `mobile` (Lighthouse's default mobile emulation, simulated throttling), Chrome on a GitHub-hosted `ubuntu-24.04` runner. "Lowest single performance" is the worst of all the individual reports.

| Page | Preset | Performance | Lowest single performance | Accessibility | LCP ms | TBT ms | CLS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sign-in (`/sign-in`, signed out) | desktop | 1.00 / 1.00 / 1.00 | 0.98 | 1.00 / 1.00 / 1.00 | 176 / 177 / 182 | 0 / 0 / 0 | 0.000 / 0.000 / 0.000 |
| Document list (`/documents`, signed in) | desktop | 1.00 / 1.00 / 1.00 | 0.99 | 1.00 / 1.00 / 1.00 | 274 / 275 / 275 | 0 / 0 / 0 | 0.000 / 0.000 / 0.000 |
| Editor (`/documents/:id`, signed in, seeded) | desktop | 1.00 / 1.00 / 1.00 | 1.00 | 1.00 / 1.00 / 1.00 | 318 / 334 / 338 | 0 / 0 / 0 | 0.022 / 0.022 / 0.022 |
| Sign-in (`/sign-in`, signed out) | mobile | 1.00 / 1.00 / 1.00 | 0.98 | 1.00 / 1.00 / 1.00 | 630 / 633 / 656 | 31 / 72 / 84 | 0.000 / 0.000 / 0.000 |
| Document list (`/documents`, signed in) | mobile | 0.99 / 1.00 / 1.00 | 0.93 | 1.00 / 1.00 / 1.00 | 969 / 975 / 978 | 40 / 76 / 98 | 0.000 / 0.000 / 0.000 |
| Editor (`/documents/:id`, signed in, seeded) | mobile | 0.98 / 0.98 / 0.99 | 0.95 | 1.00 / 1.00 / 1.00 | 1131 / 1205 / 1280 | 148 / 153 / 178 | 0.000 / 0.000 / 0.046 |

<!-- lighthouse-table:end -->
<!-- prettier-ignore-end -->

The table is from commit `5897444` (2026-11-20). Later commits changed the collab server, which no page Lighthouse measures depends on for its score, and also the editor's provider (when it announces presence) and the token route (which now carries the display name); those two are used by the editor page, so the table predates them. The Lighthouse gate (0.92) has passed in CI on every later commit; the table was not regenerated.

Conditions: a production build (`next build` and `next start`), the collab server, PostgreSQL 17 and Redis 7 running on the same runner, signed in as a verified user for the document list and the editor (a session cookie from `scripts/lighthouse/seed.mjs`, set by a Puppeteer script), the editor opened on a seeded document that holds five paragraphs, Lighthouse's default simulated throttling. **The gate is applied to the desktop preset and to the mobile emulation**: both pass, so both are enforced. Performance, accessibility and these conditions are in [`lighthouserc.cjs`](lighthouserc.cjs) and the `lighthouse` job of [`.github/workflows/ci.yml`](.github/workflows/ci.yml); the reports are the job's `lighthouse-reports` artifact. These scores describe a local, same-host server: the network between browser and server is not in them, and the editor page is measured with its socket connected but with nobody else in the document.

The scores are taken from CI, not from a laptop, because they depend on the machine. Accessibility is also checked, with axe-core, in the end-to-end suite (above).

## Performance

Measured by the sync-latency load test in `apps/collab/bench`, under the protocol in [docs/benchmarks.md](docs/benchmarks.md), which was committed before measuring began (the all-write scenario was added later, with its reason, in an addendum committed before it was run). Every number in this section is generated from the committed files in [`apps/collab/bench/results`](apps/collab/bench/results) by `scripts/benchmarks/readme-numbers.mjs`, which CI runs: the generated blocks below must equal what the files produce, and the hand-written text must contain no number at all. The runs were repeated on the release-candidate code after the security fixes; the results from before them are kept, unchanged, in [`apps/collab/bench/results/earlier-before-security-fixes`](apps/collab/bench/results/earlier-before-security-fixes).

<!-- performance-text:start -->

**The claim, as defined.** "Sync latency under 100 ms" means: with 50 editors on one document on local loopback, the 95th percentile of the time from a client applying and sending its own edit to another client having received and applied it, over every (edit, receiving editor) pair of a run, is below 100 ms in each of at least 3 runs.

**Setup.** One Apple M2 machine with 8 cores and 16 GB of RAM; the clients and the server on the loopback interface; Node v25.6.1, PostgreSQL 17.10 and Redis 8.10.3, all local. The server is the real collab server in production mode: 1 instance, Redis on (relay, connection counters, membership channel), PostgreSQL persistence on (update log compacted into snapshots), and default limits, none raised. Every editor is its own user with one socket on the same document, with cursors and presence on. A typing editor makes 3 edits per second on average, one character per edit, and moves its cursor with every character; an editor that does not type moves its cursor about every 5 seconds. Each run has 10 seconds of warm-up, a window of 60 seconds that is measured, and 5 seconds for what is still in flight to arrive. The editors are headless (`yjs` and `socket.io-client`, speaking the real sync and awareness protocol).

**Two scenarios.** In the _one-in-five_ scenario one editor in 5 types and the others only read: 50 editors, 10 of them typing; 100 editors, 20 of them typing; 200 editors, 40 of them typing; generator processes: 50 editors on 2, 100 editors on 3, 200 editors on 5. In the _all-write_ scenario every editor types, at the same rate and with the same cursor behaviour: 50 editors, 50 of them typing; 100 editors, 100 of them typing; generator processes: 50 editors on 2, 100 editors on 3. It was added after the 9 one-in-five runs, because in them only one editor in 5 wrote; see [docs/benchmarks.md](docs/benchmarks.md).

In every one of the 15 counted runs nobody was disconnected, refused or sent a `rejected` notice, the server logged no warning, every delivery arrived exactly once, and every editor and the database ended with the same document; the default limits did not throttle these loads.

**Goal 2 (50 or more editors on one document at once, with live cursors and presence), as measured:** supported with every editor typing, up to 100 editors. By run: 50 editors with 50 typing (all-write): 3 of 3 counted runs clean; 100 editors with 100 typing (all-write): 3 of 3 counted runs clean; 50 editors with 10 typing (one-in-five): 3 of 3 counted runs clean; 100 editors with 20 typing (one-in-five): 3 of 3 counted runs clean; 200 editors with 40 typing (one-in-five): 3 of 3 counted runs clean. Every editor typing was not measured above 100 editors: the one-in-five runs go up to 200 editors, of whom 40 typed.

Median over the counted runs of each size, p95 latency and mean server CPU as a percentage of one core: one-in-five: 50 editors 6.0 ms and 15%, 100 editors 6.3 ms and 25%, 200 editors 9.9 ms and 49%; all-write: 50 editors 3.7 ms and 27%, 100 editors 8.5 ms and 54%.

**The tail.** The slowest single delivery in a counted run took 106.7 ms (`allwrite-100-run3.json`, all-write, 100 editors); that run's p99 was 18.0 ms and the worst event-loop delay of its generator processes was 70.7 ms. The table shows the maximum of every run. The claim is judged on p95 and goal 2 on clean runs, not on the maximum.
<!-- performance-text:end -->

<!-- performance-table:start -->

| Results file             | Scenario    | Editors          | p50 (ms) | p95 (ms) | p99 (ms) | Slowest delivery, max (ms) | Server RSS, highest (MiB) | Server CPU, mean (% of a core) | Generator lag p99, worst process (ms, includes about a millisecond of timer slop) | Status |
| ------------------------ | ----------- | ---------------- | -------- | -------- | -------- | -------------------------- | ------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | ------ |
| `50-run1.json`           | one-in-five | 50 (10 typing)   | 2.6      | 6.0      | 8.0      | 24.1                       | 205                       | 14                             | 1.9                                                                               | valid  |
| `50-run2.json`           | one-in-five | 50 (10 typing)   | 2.8      | 6.1      | 7.9      | 19.9                       | 147                       | 15                             | 1.9                                                                               | valid  |
| `50-run3.json`           | one-in-five | 50 (10 typing)   | 2.8      | 6.0      | 7.7      | 15.8                       | 146                       | 15                             | 1.9                                                                               | valid  |
| `100-run1.json`          | one-in-five | 100 (20 typing)  | 2.4      | 6.3      | 9.0      | 23.6                       | 203                       | 25                             | 2.0                                                                               | valid  |
| `100-run2.json`          | one-in-five | 100 (20 typing)  | 2.4      | 6.0      | 9.0      | 24.0                       | 204                       | 23                             | 2.0                                                                               | valid  |
| `100-run3.json`          | one-in-five | 100 (20 typing)  | 2.5      | 6.3      | 9.7      | 40.9                       | 202                       | 25                             | 2.0                                                                               | valid  |
| `200-run1.json`          | one-in-five | 200 (40 typing)  | 3.4      | 9.9      | 15.1     | 81.4                       | 220                       | 49                             | 1.9                                                                               | valid  |
| `200-run2.json`          | one-in-five | 200 (40 typing)  | 3.5      | 10.6     | 19.1     | 62.7                       | 223                       | 48                             | 1.9                                                                               | valid  |
| `200-run3.json`          | one-in-five | 200 (40 typing)  | 3.4      | 9.8      | 14.3     | 43.5                       | 220                       | 49                             | 1.9                                                                               | valid  |
| `allwrite-50-run1.json`  | all-write   | 50 (50 typing)   | 1.6      | 3.6      | 5.5      | 74.5                       | 211                       | 27                             | 1.9                                                                               | valid  |
| `allwrite-50-run2.json`  | all-write   | 50 (50 typing)   | 1.6      | 3.8      | 6.0      | 22.3                       | 216                       | 27                             | 1.9                                                                               | valid  |
| `allwrite-50-run3.json`  | all-write   | 50 (50 typing)   | 1.6      | 3.7      | 5.3      | 46.7                       | 211                       | 27                             | 1.9                                                                               | valid  |
| `allwrite-100-run1.json` | all-write   | 100 (100 typing) | 2.5      | 8.6      | 20.0     | 104.5                      | 274                       | 54                             | 3.4                                                                               | valid  |
| `allwrite-100-run2.json` | all-write   | 100 (100 typing) | 2.4      | 7.5      | 15.2     | 78.0                       | 262                       | 54                             | 3.2                                                                               | valid  |
| `allwrite-100-run3.json` | all-write   | 100 (100 typing) | 2.5      | 8.5      | 18.0     | 106.7                      | 233                       | 55                             | 3.1                                                                               | valid  |

**The claim holds as defined:** the p95 of every one of the 3 valid runs at 50 editors is below 100 ms (highest 6.1 ms).

The generator lag column comes from the timer meter of `apps/collab/bench/lag.ts` for all 15 runs (see addendum 3 of [docs/benchmarks.md](docs/benchmarks.md)).
<!-- performance-table:end -->

**What this does and does not show.** The latency is to the receiving `Y.Doc`, so it does not include rendering in a browser. An editor count here is the number of connected editors; the text above says how many of them typed in each scenario, and the sentence about editing at once, with cursors and presence, rests on the scenario in which all of them did. The load test edits a `Y.Text`; the server relays Yjs updates without looking at what they contain, and the property test also covers the paragraph structure the editor produces. The generator lag column is the delay of the load generator's event loop (the note under the table says which instrument measured it in which runs); it cannot be below about a millisecond even when nothing is wrong, and it is there to show that the generator was not the bottleneck, not as a measurement of that much lag.

**Not measured.** Browsers (rendering, TipTap, ProseMirror); any real network (WAN, TLS, a proxy or load balancer, Wi-Fi); several server instances, and several documents at a time; a large or old document (the log is short and the snapshot small); read-only viewers; the server's event-loop lag and the CPU and memory of Redis and PostgreSQL (only the server process was sampled); editors that reconnect during a run; long soak runs; editor counts above the largest in the table, and every editor typing above the largest all-write size (the text above gives the sizes).

To measure again, see [Reproducing](docs/benchmarks.md#reproducing).

## Layout

| Path                 | What it is                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js app: pages, Auth.js, the REST API, the Prisma schema and migrations                                                                                                                           |
| `apps/collab`        | The Socket.IO collaboration server; `bench/` holds the load test and its committed results                                                                                                            |
| `packages/shared`    | Role rules (`can`), the collaboration token signer and verifier, shared types                                                                                                                         |
| `docs/design`        | Decision records                                                                                                                                                                                      |
| `docs/benchmarks.md` | What the latency claim means, the measurement protocol, and how to repeat it                                                                                                                          |
| `docs/images`        | README screenshots, produced by the e2e tests                                                                                                                                                         |
| `scripts`            | `preflight.sh`, the hygiene check, `lighthouse/` (the Lighthouse job's seed, auth and summary scripts), `benchmarks/` (the README numbers check) and `docker/` (the test database for docker-compose) |
| `lighthouserc.cjs`   | Lighthouse CI configuration: the pages, the thresholds, the desktop and mobile presets                                                                                                                |
| `docker-compose.yml` | PostgreSQL 17 and Redis 7 for development                                                                                                                                                             |

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

The editor also needs the collab server (next section). The page tells the browser where it is from `COLLAB_URL` (default `http://localhost:4000`), which is read when the page is rendered, so one build serves any deployment. The collab server must be started with `COLLAB_CORS_ORIGIN` set to the web app's origin (`http://localhost:3000` here): a browser on any other origin is refused.

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
export COLLAB_CORS_ORIGIN=http://localhost:3000  # the web app's origin; without it only the collab server's own origin may connect
export REDIS_MESSAGE_SECRET=...                  # required with REDIS_URL; the same value the web app uses
npm run start -w apps/collab                     # listens on :4000, GET /healthz
```

The web app asks for a token (`POST /api/documents/:id/collab-token`) and the client connects with `io("http://localhost:4000", { auth: { token, documentId } })`, then speaks the y-protocols sync and awareness messages in the `sync` and `awareness` events (see [0003](docs/design/0003-collab-server.md)). To run two instances behind Redis, start a second one with another `COLLAB_PORT`; they share documents through Redis and the database, and put a load balancer in front.

## Limits

Everything the collab server limits is an environment variable; the defaults are in the table, and [docs/operations.md](docs/operations.md) says what happens past each one and when to change it. Every limit has a test. The web app's account limits (sign-in, registration, invitations) are in [SECURITY.md](SECURITY.md).

| Variable                                | Default   | Meaning                                                                                                         |
| --------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `COLLAB_PORT`, `COLLAB_HOST`            | 4000, all | where it listens                                                                                                |
| `COLLAB_CORS_ORIGIN`                    | none      | browser origins allowed to connect, comma separated (WebSocket and polling); none: only the server's own origin |
| `COLLAB_MAX_UPDATE_BYTES`               | 1048576   | largest sync message                                                                                            |
| `COLLAB_MAX_AWARENESS_BYTES`            | 8192      | largest awareness message                                                                                       |
| `COLLAB_MAX_MESSAGES_PER_SECOND`        | 100       | per socket; over it the socket is disconnected                                                                  |
| `COLLAB_MESSAGE_BURST`                  | 200       | messages a socket may send at once                                                                              |
| `COLLAB_MAX_BYTES_PER_SECOND`           | 262144    | per socket; over it the socket is disconnected                                                                  |
| `COLLAB_BYTE_BURST`                     | 2097152   | bytes a socket may send at once (at least the update maximum); the replies it asks for count too                |
| `COLLAB_MAX_OUTBOUND_BYTES`             | 4194304   | queued for one connection and not yet taken by its client; over it the connection is closed                     |
| `COLLAB_MAX_OUTBOUND_PACKETS`           | 16384     | packets queued for one connection and not yet taken by the transport; over it the connection is closed          |
| `COLLAB_MAX_PACKETS_PER_SECOND`         | 250       | Engine.IO packets one connection may send, before or after it joins a document; over it it is closed            |
| `COLLAB_PACKET_BURST`                   | 500       | packets a connection may send at once                                                                           |
| `COLLAB_MAX_DOCUMENT_BYTES`             | 16777216  | snapshot plus log; past it writes are refused                                                                   |
| `COLLAB_MAX_PENDING_BYTES`              | 8388608   | accepted but not yet stored, per document; past it, disconnect                                                  |
| `COLLAB_MAX_CONNECTIONS_PER_DOCUMENT`   | 250       | across instances                                                                                                |
| `COLLAB_MAX_CONNECTIONS_PER_USER`       | 8         | sockets one user may hold on one document, across instances                                                     |
| `COLLAB_HANDSHAKE_BURST_PER_USER`       | 20        | handshakes a user may start at once, per instance                                                               |
| `COLLAB_HANDSHAKES_PER_SECOND_PER_USER` | 1         | then this many per second; over it, `rate_limited`                                                              |
| `COLLAB_HANDSHAKE_BURST_PER_IP`         | 2000      | anti-flood ceiling per client address (IPv6: per /64), per instance; counts only handshakes with a valid token  |
| `COLLAB_HANDSHAKES_PER_SECOND_PER_IP`   | 100       |                                                                                                                 |
| `COLLAB_RATE_LIMITER_MAX_KEYS`          | 100000    | users or addresses each in-memory limiter remembers; past it the least recently used are dropped and counted    |
| `COLLAB_MAX_BYTES_PER_SECOND_PER_USER`  | 524288    | shared by all of a user's sockets, per instance                                                                 |
| `COLLAB_BYTE_BURST_PER_USER`            | 4194304   | at least the update maximum                                                                                     |
| `COLLAB_MAX_IN_FLIGHT_BYTES`            | 67108864  | received but not yet processed, all sockets of the instance                                                     |
| `COLLAB_MAX_PENDING_STRUCT_BYTES`       | 1048576   | updates waiting for a missing dependency, per document                                                          |
| `COLLAB_TRUSTED_PROXY_HOPS`             | 0         | proxies in front that append to `X-Forwarded-For` (0 ignores it); **set it behind a proxy**, see operations.md  |
| `COLLAB_INSTANCE_ID`                    | random    | names this instance in logs and relayed messages; set it when running several                                   |
| `REDIS_MESSAGE_SECRET`                  | none      | required with `REDIS_URL`; signs the Redis messages                                                             |
| `COLLAB_REDIS_CONNECT_TIMEOUT_MS`       | 5000      | start fails if Redis is not reachable within this                                                               |
| `COLLAB_CONNECTION_TTL_MS`              | 45000     | a dead instance's connection slots expire after this                                                            |
| `COLLAB_COMPACT_EVERY_UPDATES`          | 200       | compact the log into a snapshot after this many updates                                                         |
| `COLLAB_COMPACT_AFTER_MS`               | 30000     | or this long after the first uncompacted update                                                                 |
| `COLLAB_UNLOAD_GRACE_MS`                | 30000     | keep a document in memory this long after its last client left                                                  |
| `COLLAB_RECONCILE_INTERVAL_MS`          | 5000      | how often an instance reads the log for updates it did not see                                                  |
| `COLLAB_MEMBERSHIP_RECHECK_MS`          | 60000     | how often sockets are checked against the `Membership` table                                                    |
| `COLLAB_ROLE_CACHE_MS`                  | 1000      | a socket's role is read again before a write if older than this                                                 |

## Security model

Every REST route checks the session and the role; the collab server verifies a signed 5-minute token and the database membership when a socket connects, and `can(role, action)` on every event after that, so a viewer cannot write and a removed member stops writing within about a second. A caller who is not a member of a document gets the same 404 as for a document that does not exist. Passwords are hashed with argon2id, sign-in and registration are rate limited, invitations and registration answer the same for every address, and messages on Redis are signed so that access to Redis alone cannot inject an update or disconnect a user. What is left, by design, is listed in the "Known limits" section. The full model: [SECURITY.md](SECURITY.md).

## Tests and checks

```sh
export DATABASE_URL=postgresql://you@localhost:5432/collabdocs_test
npm run db:deploy
npm test                # unit, route and collab server tests; they use PostgreSQL and Redis
npm run preflight       # everything CI runs
```

`scripts/preflight.sh` creates `collabdocs_test` if it is missing and uses it when `DATABASE_URL` is unset; `REDIS_URL` defaults to `redis://localhost:6379`. Set `REDIS_URL` before `npm test`. A test that cannot reach PostgreSQL or Redis fails; it does not skip. `apps/collab/test/convergence.test.ts` is a property test (fast-check): it prints its seed and run count, and `FC_SEED=<seed> FC_RUNS=<runs> npx vitest run test/convergence.test.ts` repeats a failure. The collab server tests start real servers in process on random ports and use their own Redis channel names. CI runs the same steps with PostgreSQL and Redis as service containers.

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

A route that reads a body takes JSON and answers `415` to any other `Content-Type`. A caller who is not a member of a document gets `404`, the same answer as for a document that does not exist.

| Route                                             | Needs                  | Does                                                        |
| ------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `POST /api/register`                              | nothing                | create a password account (same answer for a taken address) |
| `POST /api/verify-email`                          | nothing (a token)      | confirm an address with the token from the mail             |
| `POST /api/verify-email/resend`                   | a session              | send the caller a new verification link                     |
| `POST /api/documents`                             | a session              | create a document; the caller owns it                       |
| `GET /api/documents`                              | a session              | the documents the caller is a member of                     |
| `GET /api/documents/:id`                          | `read`                 | one document and the caller's role                          |
| `PATCH /api/documents/:id`                        | `write`                | rename                                                      |
| `DELETE /api/documents/:id`                       | `delete`               | delete, with its memberships and data                       |
| `GET /api/documents/:id/memberships`              | `read`                 | list members (with emails) and pending invitations          |
| `POST /api/documents/:id/memberships`             | `share`                | invite an address by email (always 202)                     |
| `PATCH /api/documents/:id/memberships/:uid`       | `change-role`          | change a member's role                                      |
| `DELETE /api/documents/:id/memberships/:uid`      | `change-role`, or self | remove a member, or leave                                   |
| `DELETE /api/documents/:id/invitations/:inviteId` | `change-role`          | withdraw a pending invitation                               |
| `POST /api/documents/:id/collab-token`            | `read`                 | a signed token for the collab server                        |

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
