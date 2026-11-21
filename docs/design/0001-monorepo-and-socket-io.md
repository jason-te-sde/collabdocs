# 0001. One monorepo, npm workspaces, Socket.IO for sync

Status: accepted. Update: the Socket.IO Redis adapter this record counts on was later dropped, because the collab server needed it only for the room count and its requests could wait seconds during a Redis outage; the relay channel and the connection counter are the server's own ([0003](0003-collab-server.md)).

## Context

CollabDocs has a web app, a collaboration server and rules that both must apply identically: who may do what, and what a valid collaboration token is. The collaboration server has to keep long-lived connections, which a serverless host for the web app cannot. The project's first goal is Yjs sync over Socket.IO.

## Decision

- **One repository, three workspaces.** `apps/web` (Next.js), `apps/collab` (Node, Socket.IO) and `packages/shared` (the role table `can`, the token signer and verifier, shared types). The two apps depend on `shared` and never on each other.
- **npm workspaces,** not pnpm. The build machine has Node and npm and no pnpm or corepack, and the project needs nothing pnpm offers (a strict `node_modules`, a content store) badly enough to add a tool. One `package-lock.json` is committed and CI installs with `npm ci`.
- **`shared` ships TypeScript source.** Its `exports` point at `src/index.ts`. Next.js transpiles it (`transpilePackages`), Vitest and `tsx` read it directly. There is no build step to forget and no stale `dist`. If the collab server is ever built to plain JavaScript, its bundler inlines `shared`.
- **Sync is Yjs, carried on Socket.IO,** with the y-protocols sync and awareness messages, not `y-websocket`. The first goal names Socket.IO, and its Redis adapter lets several collab instances share a document's traffic without code of our own.
- **Persistence is two tables.** `DocumentUpdate` is an append-only log; `DocumentSnapshot` holds the folded state. The collab server loads the newest snapshot and replays later updates, and compacts the log into a new snapshot from time to time. The server that uses them is described in [0003](0003-collab-server.md).
- **The web app and the collab server share one database and one secret,** not an internal API. The collab server verifies a token locally with `COLLAB_TOKEN_SECRET`, so a sync event costs no HTTP round trip.

## Consequences

- The web app and the collab server deploy separately and can scale separately.
- A rule changed in `shared` changes both sides in one commit, and one test suite covers both.
- A bundle step for `shared` will be needed if the collab server is deployed as built JavaScript.
- Socket.IO is heavier than a bare WebSocket and adds its own framing around Yjs messages. We accept that for the Redis adapter and the reconnection logic, and the load test (`apps/collab/bench`) measures what it costs.
- Both apps need `COLLAB_TOKEN_SECRET`. A leaked secret lets anyone mint tokens for any document, which is why the secret is separate from `AUTH_SECRET` and why the token's life is short.

## Alternatives rejected

- **pnpm workspaces.** Not installed here; the benefit does not justify installing a package manager and a corepack setup for a three-package repository.
- **Separate repositories.** The role table and the token format would have to be published and versioned to stay in step. In one repository they are one import.
- **`y-websocket`.** Works, and has its own persistence hooks, but gives up the Socket.IO named in the goal and the ready-made Redis adapter.
- **A shared in-process server** (the web app serving the sockets). Next.js on a serverless host cannot hold the connections, and the collab load should not share a process with page rendering.
