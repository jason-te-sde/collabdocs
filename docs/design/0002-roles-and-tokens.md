# 0002. Roles, the permission function and collaboration tokens

Status: accepted.

## Context

Every document has several people on it with different rights. The rights must hold in two places that cannot see each other's sessions: the REST routes of the web app, and each event on the collab server's sockets. A rule that is written twice drifts, and a rule that lives only in a route handler is bypassed by the socket path.

## Decision

**Three roles per document:** `owner`, `editor`, `viewer`. A user's role on a document is the `role` of their `Membership` row; no row means no access.

**Five actions:** `read`, `write`, `share`, `delete`, `change-role`.

| Role   | read | write | share | delete | change-role |
| ------ | :--: | :---: | :---: | :----: | :---------: |
| owner  | yes  |  yes  |  yes  |  yes   |     yes     |
| editor | yes  |  yes  |  yes  |   no   |     no      |
| viewer | yes  |  no   |  no   |   no   |     no      |

**One function decides:** `can(role, action)` in `packages/shared`. Every REST route calls it after loading the membership, and the socket server will call it for every event (`write` for a Yjs update, `read` to join). It denies an unknown role or action.

**404, not 403, for a non-member.** A route loads the caller's membership first. No membership gives `404 Document not found`, the same body as a document that does not exist, so a document id leaks nothing. Only a member who lacks the right gets `403`.

**Mapping of routes to actions.** Rename is `write`. Invite is `share`. Changing a role is `change-role`. Removing someone else is `change-role`; removing yourself is allowed to every member except the owner (leaving). Listing members and requesting a collaboration token are `read`.

**One owner, enforced by the database.** The owner is the creator. `Membership` has a partial unique index on `documentId` where the role is `owner`; triggers make the owner membership match `Document.ownerId`, forbid changing or deleting it while the document exists, and require that a document has it by the end of its creating transaction. `Document.ownerId` cannot change. Routes also refuse to assign `owner` (the request schema allows only `editor` and `viewer`) and answer 409 if asked to change or remove the owner. The routes give good error messages; the database makes the rule true even if a route is wrong. Ownership transfer is not part of this version.

**Collaboration tokens.** `POST /api/documents/:id/collab-token` requires `read`, and returns an HS256 JWT with:

| Claim        | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `iss`, `aud` | `collabdocs-web`, `collabdocs-collab`              |
| `sub`        | the user id                                        |
| `doc`        | the document id                                    |
| `role`       | the role held when the token was issued            |
| `iat`, `exp` | issue and expiry; 5 minutes by default, 15 at most |

The secret is `COLLAB_TOKEN_SECRET`: at least 32 bytes, and different from `AUTH_SECRET`, so that leaking one does not leak the other. `verifyCollabToken` accepts only HS256 and requires issuer, audience, expiry, a known role and the document id the connection asks for; it throws a `CollabTokenError` with a reason (`expired`, `bad-signature`, `wrong-document`, `bad-claims`, `malformed`).

## Consequences

- A change to the table in `shared` changes REST and sockets together, and the tests in `packages/shared` pin the table cell by cell.
- A token is a snapshot of a role. It cannot be revoked, so a demoted or removed member keeps the old role for at most the token's life. The collab server must therefore re-check against the database, or drop connections on a membership change; the collab server does both ([0003](0003-collab-server.md)). Five minutes is the bound if it fails to.
- A user asks for a new token by calling the endpoint again; clients refresh before expiry.
- `can` knows roles, not documents. Ownership of a specific document is a database fact, loaded per request, which costs one query per route call.
- Only registered users can be invited, since there are no pending invitations.

## Alternatives rejected

- **Roles in the session token.** Roles are per document and change, and the session lives for days.
- **Asking the web app on every socket event.** Correct and slow: it puts an HTTP round trip on the hot path of every keystroke. A signed token plus an occasional database check costs far less.
- **Row-level security in PostgreSQL.** It would enforce rules in the database for the web app's routes, but the socket server also needs the answer without a query per event, and the rule would exist in SQL and in TypeScript.
- **403 for a non-member.** Simpler to explain, and it tells an attacker which ids exist.
- **A `role` column on `Document` for the owner only.** `Document.ownerId` and the owner membership are both kept so that every access check reads one table, and the triggers keep the two in step.
